package br.com.ia4tube.app.feature.calendar.imports

import android.app.Application
import android.content.ContentProvider
import android.content.ContentValues
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowContentResolver
import java.io.File
import java.security.MessageDigest

@RunWith(RobolectricTestRunner::class)
@Config(manifest = Config.NONE, application = Application::class, sdk = [28])
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class AndroidImportSourceTest {
    @get:Rule val temporary = TemporaryFolder()
    private val uri = Uri.parse("content://synthetic-import-picker/selected-file")
    private class SelectedProvider(private val file: File, private val selected: Uri, private val mime: String) : ContentProvider() {
        var queries = 0
        var fileReads = 0
        override fun onCreate() = true
        override fun getType(uri: Uri): String { require(uri == selected); return mime }
        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            require(uri == selected && mode == "r"); fileReads++
            return ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
        }
        override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
            queries++; throw IllegalStateException("Gallery enumeration forbidden")
        }
        override fun insert(uri: Uri, values: ContentValues?): Uri? = throw IllegalStateException("No writes")
        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = throw IllegalStateException("No deletion")
        override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = throw IllegalStateException("No writes")
    }
    private fun fixture(mime: String = "image/png"): Pair<File, SelectedProvider> {
        val file = temporary.newFile("synthetic.png")
        val bitmap = Bitmap.createBitmap(30, 40, Bitmap.Config.ARGB_8888)
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        val provider = SelectedProvider(file, uri, mime)
        provider.attachInfo(RuntimeEnvironment.getApplication(), ProviderInfo().apply { authority = uri.authority })
        ShadowContentResolver.registerProviderInternal(uri.authority, provider)
        return file to provider
    }

    @Test fun selectedPhotoUsesActualStreamHashAndDimensionsWithoutListingGallery() = runBlocking {
        val (file, provider) = fixture()
        val source = AndroidImportSource(RuntimeEnvironment.getApplication())
        val selection = source.inspect(uri)
        assertEquals(ImportMediaKind.IMAGE, selection.kind)
        assertEquals(30, selection.width); assertEquals(40, selection.height)
        assertEquals(file.length(), selection.byteCount)
        assertEquals(MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }, selection.sha256)
        assertArrayEquals(file.readBytes(), source.part(uri, selection, 0))
        assertEquals(0, provider.queries)
        assertTrue(provider.fileReads >= 2)
    }

    @Test fun unsupportedMimeAndRemoteUriAreRejectedWithoutReadingOrLeakingReference() = runBlocking {
        val (_, provider) = fixture("image/heic")
        val source = AndroidImportSource(RuntimeEnvironment.getApplication())
        for (target in listOf(uri, Uri.parse("https://private.invalid/secret"))) {
            try { source.inspect(target); fail("Expected rejection") } catch (error: ImportSourceFailure) {
                assertFalse(error.message!!.contains(target.toString()))
                // Coroutines may attach the original, already-sanitized exception for stack recovery.
                assertTrue(error.cause == null || error.cause is ImportSourceFailure)
            }
        }
        assertEquals(0, provider.fileReads); assertEquals(0, provider.queries)
    }
}
