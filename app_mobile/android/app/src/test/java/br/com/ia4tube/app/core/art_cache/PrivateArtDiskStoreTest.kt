package br.com.ia4tube.app.core.art_cache

import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.file.Files
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assume.assumeNoException
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class PrivateArtDiskStoreTest {
    @get:Rule val temporary = TemporaryFolder()
    private val keyA = "a".repeat(64)
    private val keyB = "b".repeat(64)
    private val keyC = "c".repeat(64)
    private val cipher = TestCipher()

    private class TestCipher : ArtCacheCipher {
        private val secret = SecretKeySpec(ByteArray(32).also { SecureRandom().nextBytes(it) }, "AES")
        override fun encrypt(key: String, plain: ByteArray): ByteArray {
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, secret)
            cipher.updateAAD(key.toByteArray())
            return cipher.iv + cipher.doFinal(plain)
        }
        override fun decrypt(key: String, sealed: ByteArray): ByteArray {
            require(sealed.size > 28)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, secret, GCMParameterSpec(128, sealed.copyOfRange(0, 12)))
            cipher.updateAAD(key.toByteArray())
            return cipher.doFinal(sealed.copyOfRange(12, sealed.size))
        }
    }

    private fun root() = File(temporary.root, "private-art")
    private fun art(value: String = "private image payload that must never appear on disk") =
        SavedPrivateArt(value.toByteArray(), "image/png", "\"private-etag\"", "Wed, 09 Sep 2026 10:00:00 GMT")
    private fun entry(root: File, key: String) = File(root, "$key.art")

    @Test fun putGetAndReopenKeepEncryptedBytesAndMetadata() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher)
        val expected = art()
        store.put(keyA, expected)
        val raw = entry(root, keyA).readBytes()
        assertFalse(raw.toString(Charsets.ISO_8859_1).contains(expected.bytes.toString(Charsets.UTF_8)))
        assertFalse(raw.toString(Charsets.ISO_8859_1).contains(expected.contentType))
        assertFalse(raw.toString(Charsets.ISO_8859_1).contains(expected.etag!!))
        val actual = PrivateArtDiskStore(root, cipher).get(keyA)!!
        assertArrayEquals(expected.bytes, actual.bytes)
        assertEquals(expected.contentType, actual.contentType)
        assertEquals(expected.etag, actual.etag)
        assertEquals(expected.lastModified, actual.lastModified)
        assertArrayEquals(art().bytes, expected.bytes)
        assertEquals(listOf("$keyA.art"), root.list()!!.toList())
    }

    @Test fun nullValidatorsRoundTripAndReturnedBytesDoNotModifyStoredArt() {
        val store = PrivateArtDiskStore(root(), cipher)
        store.put(keyA, art().copy(etag = null, lastModified = null))
        val first = store.get(keyA)!!
        assertNull(first.etag)
        assertNull(first.lastModified)
        first.bytes.fill(0)
        assertArrayEquals(art().bytes, store.get(keyA)!!.bytes)
    }

    @Test fun invalidKeysCannotCreateReadOrDeleteOutsideTheOwnedNamespace() {
        val root = root()
        val unrelated = temporary.newFile("outside.txt").apply { writeText("keep") }
        val store = PrivateArtDiskStore(root, cipher)
        val invalidKeys = listOf("", "../outside.txt", keyA.uppercase(), keyA + ".art", "z".repeat(64), "a".repeat(63))
        for (key in invalidKeys) {
            store.put(key, art())
            assertNull(store.get(key))
            store.remove(key)
        }
        assertFalse(root.exists())
        assertEquals("keep", unrelated.readText())
    }

    @Test fun tamperedCiphertextIsRemovedAndDoesNotBreakOtherImages() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher)
        store.put(keyA, art("first"))
        store.put(keyB, art("second"))
        val path = entry(root, keyA)
        val bytes = path.readBytes()
        bytes[bytes.lastIndex] = (bytes.last().toInt() xor 1).toByte()
        path.writeBytes(bytes)
        assertNull(store.get(keyA))
        assertFalse(path.exists())
        assertArrayEquals("second".toByteArray(), store.get(keyB)!!.bytes)
    }

    @Test fun swappingFilesCannotCrossCacheKeysBecauseCipherAuthenticatesKey() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher)
        store.put(keyA, art("account A"))
        store.put(keyB, art("account B"))
        entry(root, keyB).writeBytes(entry(root, keyA).readBytes())
        assertNull(store.get(keyB))
        assertFalse(entry(root, keyB).exists())
        assertArrayEquals("account A".toByteArray(), store.get(keyA)!!.bytes)
    }

    @Test fun countQuotaEvictsLeastRecentlyUsedEvenAfterReopen() {
        val root = root()
        var store = PrivateArtDiskStore(root, cipher, maxEntries = 2)
        store.put(keyA, art("first"))
        store.put(keyB, art("second"))
        store = PrivateArtDiskStore(root, cipher, maxEntries = 2)
        assertNotNull(store.get(keyA))
        store.put(keyC, art("third"))
        assertNull(store.get(keyB))
        assertNotNull(store.get(keyA))
        assertNotNull(store.get(keyC))
        assertEquals(2, root.listFiles()!!.size)
    }

    @Test fun byteQuotaUsesCiphertextSizeIncludingMetadataAndEncryptionOverhead() {
        val root = root()
        val initial = PrivateArtDiskStore(root, cipher)
        initial.put(keyA, art("same-size"))
        val encryptedSize = entry(root, keyA).length()
        assertTrue(encryptedSize > art("same-size").bytes.size)
        val store = PrivateArtDiskStore(root, cipher, maxBytes = encryptedSize * 2 - 1)
        store.put(keyB, art("same-size"))
        assertNull(store.get(keyA))
        assertNotNull(store.get(keyB))
        assertTrue(root.listFiles()!!.sumOf { it.length() } <= encryptedSize * 2 - 1)
    }

    @Test fun oversizedAndInvalidMetadataAreNeverStored() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher, maxImageBytes = 64)
        store.put(keyA, art().copy(bytes = ByteArray(65)))
        store.put(keyA, art().copy(bytes = byteArrayOf()))
        store.put(keyA, art().copy(contentType = ""))
        store.put(keyA, art().copy(etag = "a".repeat(1025)))
        store.put(keyA, art().copy(lastModified = "bad\r\nheader"))
        assertNull(store.get(keyA))
        assertFalse(root.exists())
    }

    @Test fun clearAndRemoveNeverRecurseOrRemoveUnrelatedFiles() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher)
        store.put(keyA, art())
        store.put(keyB, art())
        val unrelated = File(root, "keep.txt").apply { writeText("keep") }
        val child = File(root, "$keyC.art").apply { mkdir() }
        val nested = File(child, "keep.txt").apply { writeText("keep child") }
        val partial = File(root, "$keyA.${"d".repeat(32)}.tmp").apply { writeText("interrupted ciphertext") }
        val otherTemporary = File(root, "unrelated.tmp").apply { writeText("keep temp") }
        store.remove(keyA)
        assertFalse(entry(root, keyA).exists())
        assertNotNull(store.get(keyB))
        store.clear()
        assertFalse(entry(root, keyB).exists())
        assertFalse(partial.exists())
        assertEquals("keep", unrelated.readText())
        assertEquals("keep child", nested.readText())
        assertEquals("keep temp", otherTemporary.readText())
        assertTrue(root.exists())
    }

    @Test fun partialOrHugeRecordsAreRemovedWithoutLargeAllocation() {
        val root = root().apply { mkdir() }
        val store = PrivateArtDiskStore(root, cipher, maxImageBytes = 64)
        val path = entry(root, keyA)
        path.writeBytes(byteArrayOf(1, 2, 3))
        assertNull(store.get(keyA))
        assertFalse(path.exists())
        path.writeBytes(ByteArray(90_000))
        assertNull(store.get(keyA))
        assertFalse(path.exists())
    }

    @Test fun authenticatedButMalformedRecordIsNotReturned() {
        val root = root().apply { mkdir() }
        val store = PrivateArtDiskStore(root, cipher, maxImageBytes = 64)
        fun malformed(declaredLength: Int, extra: Boolean = false): ByteArray {
            val out = ByteArrayOutputStream()
            DataOutputStream(out).use { data ->
                data.writeInt(0x49413441)
                data.writeInt(1)
                data.writeInt(9)
                data.write("image/png".toByteArray())
                data.writeInt(-1)
                data.writeInt(-1)
                data.writeInt(declaredLength)
                data.write(byteArrayOf(1, 2, 3))
                if (extra) data.writeByte(4)
            }
            return out.toByteArray()
        }
        for (plain in listOf(malformed(65), malformed(4), malformed(-1), malformed(3, extra = true))) {
            entry(root, keyA).writeBytes(cipher.encrypt(keyA, plain))
            assertNull(store.get(keyA))
            assertFalse(entry(root, keyA).exists())
        }
    }

    @Test fun encryptionOrStorageFailureDoesNotErasePreviousValidEntry() {
        val root = root()
        PrivateArtDiskStore(root, cipher).put(keyA, art("original"))
        val unavailable = object : ArtCacheCipher {
            override fun encrypt(key: String, plain: ByteArray): ByteArray = error("unavailable key")
            override fun decrypt(key: String, sealed: ByteArray): ByteArray = error("unavailable key")
        }
        PrivateArtDiskStore(root, unavailable).put(keyA, art("replacement"))
        assertArrayEquals("original".toByteArray(), PrivateArtDiskStore(root, cipher).get(keyA)!!.bytes)
        val fileInsteadOfDirectory = temporary.newFile("not-a-directory")
        val blocked = PrivateArtDiskStore(fileInsteadOfDirectory, cipher)
        blocked.put(keyA, art())
        assertNull(blocked.get(keyA))
        blocked.clear()
        assertTrue(fileInsteadOfDirectory.isFile)
    }

    @Test fun replacementIsCompleteAndLeavesNoTemporaryPlaintextOrCiphertextFiles() {
        val root = root()
        val store = PrivateArtDiskStore(root, cipher)
        store.put(keyA, art("first"))
        store.put(keyA, art("replacement"))
        assertArrayEquals("replacement".toByteArray(), store.get(keyA)!!.bytes)
        assertEquals(listOf("$keyA.art"), root.list()!!.toList())
    }

    @Test fun ownedSymlinkDoesNotReadOrDeleteItsTarget() {
        val root = root().apply { mkdir() }
        val outside = temporary.newFile("outside-art").apply { writeText("keep") }
        val link = entry(root, keyA).toPath()
        try {
            Files.createSymbolicLink(link, outside.toPath())
        } catch (error: Exception) {
            // Report a real skipped test if this Windows host cannot create a symlink.
            assumeNoException("Host does not allow creating symbolic links", error)
            return
        }
        val store = PrivateArtDiskStore(root, cipher)
        assertNull(store.get(keyA))
        store.clear()
        assertEquals("keep", outside.readText())
    }
}
