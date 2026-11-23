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
        return true
    }

    // Appli à l'écran : c'est la page qui sonne, pas besoin d'une notification en plus.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([])
    }
}
