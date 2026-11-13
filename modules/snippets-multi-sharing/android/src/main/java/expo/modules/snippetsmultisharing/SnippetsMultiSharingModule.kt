package expo.modules.snippetsmultisharing

import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

class SnippetsMultiSharingModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private var pendingPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("SnippetsMultiSharing")

    AsyncFunction("shareImagesAsync") { urls: List<String>, mimeType: String?, promise: Promise ->
      shareImages(urls, mimeType, promise)
    }.runOnQueue(Queues.MAIN)

    // Keep the previous bridge name available to older JavaScript bundles.
    AsyncFunction("shareImagesToWhatsApp") { urls: List<String>, mimeType: String?, promise: Promise ->
      shareImages(urls, mimeType, promise)
    }.runOnQueue(Queues.MAIN)

    OnActivityResult { _, (requestCode) ->
      if (requestCode == REQUEST_CODE) {
        val promise = pendingPromise
        pendingPromise = null
        promise?.resolve(null)
      }
    }

    OnDestroy {
      pendingPromise?.reject("ERR_SHARE_INTERRUPTED", "Sharing was interrupted.", null)
      pendingPromise = null
    }
  }

  private fun shareImages(urls: List<String>, mimeType: String?, promise: Promise) {
    if (pendingPromise != null) {
      throw IllegalStateException("Another share is already in progress.")
    }
    require(urls.size >= 2) { "Select at least two images to share." }

    val activity = appContext.throwingActivity
    val shareUris = ArrayList<Uri>(urls.size)
    urls.forEach { rawUrl ->
      val parsed = Uri.parse(rawUrl)
      val uri = when (parsed.scheme?.lowercase()) {
        "content" -> parsed
        "file" -> {
          val file = File(parsed.path ?: throw IllegalArgumentException("The image path is missing."))
          require(file.isFile && file.canRead()) { "An image file is not available." }
          FileProvider.getUriForFile(
            context,
            context.packageName + ".SharingFileProvider",
            file,
          )
        }
        else -> throw IllegalArgumentException("Only local images can be shared.")
      }
      shareUris.add(uri)
    }

    val sharedMimeType = mimeType?.takeIf { it.startsWith("image/") } ?: "image/*"
    val clips = ClipData("Snippets images", arrayOf(sharedMimeType), ClipData.Item(shareUris.first()))
    shareUris.drop(1).forEach { uri -> clips.addItem(ClipData.Item(uri)) }
    val sendIntent = Intent(Intent.ACTION_SEND_MULTIPLE).apply {
      type = sharedMimeType
      putParcelableArrayListExtra(Intent.EXTRA_STREAM, shareUris)
      clipData = clips
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }
    val chooser = Intent.createChooser(sendIntent, "Share images").apply {
      clipData = clips
      addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    }

    pendingPromise = promise
    try {
      activity.startActivityForResult(chooser, REQUEST_CODE)
    } catch (error: Exception) {
      pendingPromise = null
      promise.reject("ERR_SHARE_IMAGES", "Could not open the share sheet.", error)
    }
  }

  companion object {
    private const val REQUEST_CODE = 51941
  }
}
