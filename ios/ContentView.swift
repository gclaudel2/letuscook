// Let Us Cook — app iPhone
// Écran principal : letuscook dans une vue web, plus les fonctions natives.
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
// Clé de l'app pour le relais Cloudflare (secret APP_KEY) : sans code d'accès, et le relais refuse l'IA
let relayAppKey = "CLE_APP_KEY_DU_RELAIS"
let slate = UIColor(red: 0x1F / 255, green: 0x2A / 255, blue: 0x26 / 255, alpha: 1)

// ── Liens qui ouvrent l'app : https://<relais>/rejoindre/<carnet>.<code> → page « rejoindre » de letuscook ──
enum LinkRouter {
    static let notification = Notification.Name("letuscook.openLink")
    static var pending: URL?          // lien reçu avant que la page soit prête (app lancée par le lien)

    static func pageURL(for link: URL) -> URL? {
        let path = link.path
        if path.hasPrefix("/rejoindre/") {
            let code = String(path.dropFirst("/rejoindre/".count))
            guard code.range(of: "^[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$", options: .regularExpression) != nil else { return nil }
            return URL(string: appURL.absoluteString + "#/rejoindre/" + code)
        }
        if link.host == appHost { return link }
        return nil
    }

    static func open(_ link: URL) {
        guard let url = pageURL(for: link) else { return }
        pending = url
        NotificationCenter.default.post(name: notification, object: url)
    }
}

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
        // Version App Store : clé du relais (remplace le code d'accès) et aucune fonction IA
        config.userContentController.addUserScript(WKUserScript(
            source: "window.LUC_APP = Object.freeze({ key: \"\(relayAppKey)\", noAI: true, store: true });",
            injectionTime: .atDocumentStart, forMainFrameOnly: true))

        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = context.coordinator
        web.uiDelegate = context.coordinator
        web.allowsBackForwardNavigationGestures = true          // balayage depuis le bord gauche = retour
        web.scrollView.contentInsetAdjustmentBehavior = .never  // la page gère elle-même l'encoche
        web.isOpaque = false
        web.backgroundColor = slate
        #if DEBUG
        web.isInspectable = true                                // débogage depuis Safari sur le Mac
        #endif
        context.coordinator.web = web
        // Toujours la dernière version publiée (sans ça, la page peut rester 10 min en cache)
        web.load(URLRequest(url: LinkRouter.pending ?? appURL, cachePolicy: .reloadRevalidatingCacheData))
        LinkRouter.pending = nil
        context.coordinator.listenForLinks()
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}
}

@MainActor
final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    weak var web: WKWebView?

    func listenForLinks() {
        NotificationCenter.default.addObserver(forName: LinkRouter.notification, object: nil, queue: .main) { [weak self] note in
            guard let url = note.object as? URL else { return }
            MainActor.assumeIsolated {
                LinkRouter.pending = nil
                self?.web?.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData))
            }
        }
    }

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
    static func sync(_ list: [[String: Any]]) {
        // On extrait les valeurs tout de suite (types simples), puis on travaille avec les callbacks du centre de notifications
        let timers: [(id: String, endAt: Double, name: String, recipe: String)] = list.compactMap { t in
            guard let id = t["id"] as? String, let endAt = (t["endAt"] as? NSNumber)?.doubleValue else { return nil }
            return (id, endAt, t["name"] as? String ?? "Minuteur", t["recipe"] as? String ?? "")
        }
        let center = UNUserNotificationCenter.current()
        let wanted = Set(timers.map { "timer-\($0.id)" })
        center.getPendingNotificationRequests { pending in
            let stale = pending.map(\.identifier).filter { $0.hasPrefix("timer-") && !wanted.contains($0) }
            center.removePendingNotificationRequests(withIdentifiers: stale)
            guard !timers.isEmpty else { return }
            // La première fois, l'iPhone demande l'autorisation d'envoyer des notifications
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                guard granted else { return }
                let now = Date().timeIntervalSince1970
                for t in timers {
                    let delay = t.endAt / 1000 - now
                    if delay < 1 { continue }
                    let content = UNMutableNotificationContent()
                    content.title = "⏰ \(t.name) : c'est prêt !"
                    if !t.recipe.isEmpty { content.body = t.recipe }
                    content.sound = .default
                    let trigger = UNTimeIntervalNotificationTrigger(timeInterval: delay, repeats: false)
                    // même identifiant = la notification est remplacée (pause, +1 min…)
                    center.add(UNNotificationRequest(identifier: "timer-\(t.id)", content: content, trigger: trigger))
                }
            }
        }
    }
}
