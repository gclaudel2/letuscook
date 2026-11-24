// letuscook — app iPhone
// Point d entrée de l app.

import SwiftUI
import UserNotifications

@main
struct LetUsCookApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        WindowGroup {
            ContentView()
                // Lien d'invitation touché dans Messages, WhatsApp, Mail… (lien universel du relais)
                .onOpenURL { LinkRouter.open($0) }
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        // Notifications déjà autorisées : on redemande le jeton (il peut changer)
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized else { return }
            DispatchQueue.main.async { UIApplication.shared.registerForRemoteNotifications() }
        }
        return true
    }

    // Jeton de notification de cet iPhone : la page l'envoie au relais pour chaque carnet partagé
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushBridge.received(deviceToken.map { String(format: "%02x", $0) }.joined())
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {}

    // Appli à l'écran : c'est la page qui sonne, pas besoin d'une notification en plus.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        // Nouvelle recette dans un carnet partagé : bandeau + synchro tout de suite ; minuteurs : la page sonne déjà
        if notification.request.trigger is UNPushNotificationTrigger {
            DispatchQueue.main.async { PushBridge.run("window.Sync && Sync.all()") }
            completionHandler([.banner, .list, .sound])
        } else {
            completionHandler([])
        }
    }

    // Notification touchée : on ouvre le carnet concerné
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let bookId = response.notification.request.content.userInfo["bookId"] as? String
        DispatchQueue.main.async {
            if let bookId { PushBridge.openBook(bookId) }
            completionHandler()
        }
    }
}
