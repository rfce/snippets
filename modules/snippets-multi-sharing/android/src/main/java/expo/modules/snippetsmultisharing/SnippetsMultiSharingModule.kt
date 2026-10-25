package expo.modules.snippetsmultisharing

import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class SnippetsMultiSharingModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  override fun definition() = ModuleDefinition {
    Name("SnippetsMultiSharing")

    AsyncFunction("shareImagesToWhatsApp") { urls: List<String>, mimeType: String? ->
      if (urls.size < 2) {
        throw IllegalArgumentException("At least two images are required for multiple-image sharing.")
      }

      val shareUris = ArrayList<Uri>(urls.size)
      urls.forEach { rawUrl ->
        val parsedUri = Uri.parse(rawUrl)
        val shareUri = when (parsedUri.scheme?.lowercase()) {
          "content" -> parsedUri
          "file" -> {
            val path = parsedUri.path
              ?: throw IllegalArgumentException("The image file path is missing.")
            FileProvider.getUriForFile(
              context,
              "${context.packageName}.SharingFileProvider",
              File(path),
            )
          }
          else -> throw IllegalArgumentException(
            "Only local image files can be shared (received ${parsedUri.scheme ?: "no URI scheme"}).",
          )
        }
        shareUris.add(shareUri)
      }

      val intent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
        type = mimeType ?: "image/*"
        putParcelableArrayListExtra(Intent.EXTRA_STREAM, shareUris)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }

      val targetPackage = listOf("com.whatsapp", "com.whatsapp.w4b").firstOrNull { packageName ->
        intent.setPackage(packageName)
        intent.resolveActivity(context.packageManager) != null
      } ?: throw IllegalStateException("WhatsApp is not installed on this device.")

      intent.setPackage(targetPackage)
      shareUris.forEach { uri ->
        context.grantUriPermission(
          targetPackage,
          uri,
          Intent.FLAG_GRANT_READ_URI_PERMISSION,
        )
      }

      appContext.throwingActivity.startActivity(intent)
    }.runOnQueue(Queues.MAIN)
  }
}
