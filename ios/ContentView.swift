// letuscook — app iPhone
// Remplacez TOUT le contenu du fichier « ContentView.swift » de votre projet Xcode par ce fichier.
//
// L'app affiche letuscook (le site GitHub Pages) et ajoute ce qu'un site web ne peut pas faire :
//  • les minuteurs deviennent de vraies notifications : elles sonnent écran éteint ou appli fermée ;
//  • l'écran reste allumé pendant la recette ;
//  • les liens externes, e-mails, SMS et WhatsApp s'ouvrent dans les apps de l'iPhone.

import SwiftUI
import WebKit
import UserNotifications

let appURL = URL(string: "https://gclaudel2.github.io/letuscook/")!
let appHost = "gclaudel2.github.io"
let slate = UIColor(red: 0x1F / 255, green: 0x2A / 255, blue: 0x26 / 255, alpha: 1)

struct ContentView: View {
    var body: some View {
        WebView()
            .ignoresSafeArea()
            .background(Color(slate))
    }
}

struct WebView: UIViewRepresentable {
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []   // lecture à voix haute du mode cuisine
        config.applicationNameForUserAgent = "letuscook-ios"
        config.userContentController.add(context.coordinator, name: "letuscook")

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true          // balayage depuis le bord gauche = retour
        web.scrollView.contentInsetAdjustmentBehavior = .never  // la page gère elle-même l'encoche
        web.isOpaque = false
        web.backgroundColor = slate
        web.isInspectable = true                                // débogage depuis Safari sur le Mac
        context.coordinator.web = web
        // Toujours la dernière version publiée (sans ça, la page peut rester 10 min en cache)
        web.load(URLRequest(url: appURL, cachePolicy: .reloadRevalidatingCacheData))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}
}

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var web: WKWebView?

    // ── Messages envoyés par la page (window.webkit.messageHandlers.letuscook) ──
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        switch type {
        case "wake":
            UIApplication.shared.isIdleTimerDisabled = (body["on"] as? Bool) ?? false
        case "timers":
            TimerNotifications.sync(body["list"] as? [[String: Any]] ?? [])
        default:
            break
        }
    }

    // ── Navigation : letuscook reste dans l'app, le reste part vers Safari / Mail / Messages / WhatsApp ──
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = action.request.url else { return decisionHandler(.cancel) }
        let scheme = url.scheme?.lowercased() ?? ""
        if scheme == "http" || scheme == "https" {
            if url.host == appHost || action.targetFrame?.isMainFrame == false { return decisionHandler(.allow) }
            UIApplication.shared.open(url)
            return decisionHandler(.cancel)
        }
        if ["about", "blob", "data"].contains(scheme) { return decisionHandler(.allow) }
        UIApplication.shared.open(url)   // mailto:, sms:, tel:, whatsapp:…
        decisionHandler(.cancel)
    }

    // Liens « nouvel onglet » (target=_blank)
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { UIApplication.shared.open(url) }
        return nil
    }

    // Si la page plante (mémoire), on la recharge
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    // Micro (commandes vocales) : pas de seconde question pour letuscook
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == appHost ? .grant : .prompt)
    }

    // ── alert(), confirm(), prompt() de la page : sans ça, WKWebView les ignore ──
    private func present(_ alert: UIAlertController) -> Bool {
        guard var top = web?.window?.rootViewController else { return false }
        while let next = top.presentedViewController { top = next }
        top.present(alert, animated: true)
        return true
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        if !present(alert) { completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        if !present(alert) { completionHandler(false) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: nil, message: prompt, preferredStyle: .alert)
        alert.addTextField { $0.text = defaultText }
        alert.addAction(UIAlertAction(title: "Annuler", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak alert] _ in
            completionHandler(alert?.textFields?.first?.text)
        })
        if !present(alert) { completionHandler(nil) }
    }
}

// ── Minuteurs → notifications locales programmées à l'heure de fin ──
enum TimerNotifications {
    @MainActor
    static func sync(_ list: [[String: Any]]) {
        Task {
            let center = UNUserNotificationCenter.current()
            let wanted = Set(list.compactMap { $0["id"] as? String }.map { "timer-\($0)" })
            let pending = await center.pendingNotificationRequests().map(\.identifier)
            center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.hasPrefix("timer-") && !wanted.contains($0) })
            guard !list.isEmpty else { return }
            // La première fois, l'iPhone demande l'autorisation d'envoyer des notifications
            guard (try? await center.requestAuthorization(options: [.alert, .sound])) == true else { return }
            let now = Date().timeIntervalSince1970
            for timer in list {
                guard let id = timer["id"] as? String,
                      let endAt = (timer["endAt"] as? NSNumber)?.doubleValue else { continue }
                let delay = endAt / 1000 - now
                if delay < 1 { continue }
                let content = UNMutableNotificationContent()
                content.title = "⏰ \(timer["name"] as? String ?? "Minuteur") : c'est prêt !"
                if let recipe = timer["recipe"] as? String, !recipe.isEmpty { content.body = recipe }
                content.sound = .default
                let trigger = UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
                // même identifiant = la notification est remplacée (pause, +1 min…)
                try? await center.add(UNNotificationRequest(identifier: "timer-\(id)", content: content, trigger: trigger))
            }
        }
    }
}
