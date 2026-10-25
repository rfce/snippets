import ExpoModulesCore
import UIKit

public final class SnippetsMultiSharingModule: Module {
  public func definition() -> ModuleDefinition {
    Name("SnippetsMultiSharing")

    AsyncFunction("shareImagesToWhatsApp") { (urls: [URL]) in
      guard urls.count >= 2 else {
        throw NSError(
          domain: "SnippetsMultiSharing",
          code: 1,
          userInfo: [NSLocalizedDescriptionKey: "At least two images are required for multiple-image sharing."]
        )
      }

      guard let viewController = appContext?.utilities?.currentViewController() else {
        throw NSError(
          domain: "SnippetsMultiSharing",
          code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Unable to open the iOS share sheet."]
        )
      }

      let activityController = UIActivityViewController(
        activityItems: urls,
        applicationActivities: nil
      )

      if let popover = activityController.popoverPresentationController {
        popover.sourceView = viewController.view
        popover.sourceRect = CGRect(
          x: viewController.view.bounds.midX,
          y: viewController.view.bounds.maxY,
          width: 0,
          height: 0
        )
      }

      viewController.present(activityController, animated: true)
    }
    .runOnQueue(.main)
  }
}
