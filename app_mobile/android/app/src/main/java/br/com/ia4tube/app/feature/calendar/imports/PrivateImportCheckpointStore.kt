package br.com.ia4tube.app.feature.calendar.imports

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.LinkOption
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject
import java.util.UUID

interface ImportCheckpointCipher {
    fun encrypt(scope: String, plain: ByteArray): ByteArray
    fun decrypt(scope: String, sealed: ByteArray): ByteArray
}

class ImportCheckpointFailure(val code: String) : Exception("Não foi possível recuperar o envio privado. Não inicie outro envio até conferir o anterior.")

/** One active draft per owner. Atomic, authenticated encryption; no plaintext fallback or secret logs. */
class PrivateImportCheckpointStore(directory: File, private val cipher: ImportCheckpointCipher) {
    private val root = directory.absoluteFile
    init {
        if (root.exists()) require(root.isDirectory && !Files.isSymbolicLink(root.toPath()))
        else require(root.mkdirs())
        require(root.canonicalFile == root)
    }

    fun read(owner: ImportOwner): ImportDurableCheckpoint? = locked(owner) { scope -> readLocked(owner, scope) }

    fun readGeneratedIntent(owner: ImportOwner): ImportGeneratedSourceIntent? = locked(owner) { scope -> readGeneratedLocked(scope) }
    /** Source dimensions are not known until the server resolves an existing art. Persist its intent separately first. */
    fun prepareGeneratedIntent(owner: ImportOwner, calendarItemId: String, revision: Long): ImportGeneratedSourceIntent = locked(owner) { scope ->
        val existing = readGeneratedLocked(scope)
        if (existing != null) {
            if (existing.calendarItemId != calendarItemId || existing.revision != revision) throw ImportCheckpointFailure("checkpoint_generated_conflict")
            return@locked existing
        }
        if (readLocked(owner, scope) != null) throw ImportCheckpointFailure("checkpoint_existing_draft")
        val intent = ImportGeneratedSourceIntent(calendarItemId, revision, UUID.randomUUID().toString())
        val plain = JSONObject().put("calendarItemId", intent.calendarItemId).put("revision", intent.revision)
            .put("idempotencyKey", intent.idempotencyKey).toString().toByteArray(Charsets.UTF_8)
        val sealed = try { cipher.encrypt("$scope:generated", plain) } finally { plain.fill(0) }
        val target = child("$scope.generated.bin"); val pending = child("$scope.generated.pending")
        ensureRegularOrAbsent(target); ensureRegularOrAbsent(pending)
        try {
            FileOutputStream(pending, false).use { it.write(sealed); it.fd.sync() }
            Files.move(pending.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { sealed.fill(0); if (pending.exists() && !Files.isSymbolicLink(pending.toPath())) pending.delete() }
        intent
    }
    fun clearAcceptedGeneratedIntent(owner: ImportOwner, intent: ImportGeneratedSourceIntent, expectedGeneration: Long) = locked(owner) { scope ->
        val checkpoint = readLocked(owner, scope)
        if (checkpoint?.generation != expectedGeneration || checkpoint.generatedSource != intent ||
            readGeneratedLocked(scope)?.let { it != intent } == true) throw ImportCheckpointFailure("checkpoint_conflict")
        val file = child("$scope.generated.bin"); ensureRegularOrAbsent(file)
        if (file.exists() && !file.delete()) throw ImportCheckpointFailure("checkpoint_storage_unavailable")
    }

    /** Persist before any mutating HTTP request. A stale callback cannot overwrite a newer checkpoint. */
    fun write(owner: ImportOwner, expectedGeneration: Long, draft: ImportDurableCheckpoint): ImportDurableCheckpoint = locked(owner) { scope ->
        require(draft.state.owner == owner)
        val present = readLocked(owner, scope)
        val sourceIntent = readGeneratedLocked(scope)
        if (sourceIntent != null && sourceIntent != draft.generatedSource) throw ImportCheckpointFailure("checkpoint_generated_pending")
        if ((present?.generation ?: 0L) != expectedGeneration || expectedGeneration == Long.MAX_VALUE ||
            present != null && present.state.draftId != draft.state.draftId)
            throw ImportCheckpointFailure("checkpoint_conflict")
        val next = draft.copy(generation = expectedGeneration + 1)
        val plain = ImportCheckpointCodec.encode(next)
        val sealed = try { cipher.encrypt(scope, plain) } finally { plain.fill(0) }
        require(sealed.size in 28..(ImportCheckpointCodec.MAX_BYTES + 128))
        val target = child("$scope.bin")
        val pending = child("$scope.pending")
        ensureRegularOrAbsent(target); ensureRegularOrAbsent(pending)
        try {
            FileOutputStream(pending, false).use { stream -> stream.write(sealed); stream.fd.sync() }
            ensureRegularOrAbsent(target)
            Files.move(pending.toPath(), target.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            next
        } finally {
            sealed.fill(0)
            // Exact temporary file only; never clear another tenant, phone files or existing checkpoint.
            if (pending.exists() && !Files.isSymbolicLink(pending.toPath())) pending.delete()
        }
    }

    /** Only an explicitly finished/discarded draft may be removed, with optimistic generation check. */
    fun clear(owner: ImportOwner, expectedGeneration: Long, expectedDraftId: String? = null) = locked(owner) { scope ->
        val present = readLocked(owner, scope)
        if ((present?.generation ?: 0L) != expectedGeneration ||
            expectedDraftId != null && present?.state?.draftId != expectedDraftId) throw ImportCheckpointFailure("checkpoint_conflict")
        if (present?.calendarSubmission != null || present?.state?.phase in setOf(ImportPhase.INITIALIZING, ImportPhase.VERIFYING, ImportPhase.CANCEL_PENDING, ImportPhase.SCHEDULING))
            throw ImportCheckpointFailure("checkpoint_uncertain")
        val file = child("$scope.bin")
        ensureRegularOrAbsent(file)
        if (file.exists() && !file.delete()) throw ImportCheckpointFailure("checkpoint_storage_unavailable")
    }

    /** A server receipt transfers responsibility to the durable server job, even before media is ready. */
    fun clearAcceptedCalendarSubmission(owner: ImportOwner, expectedGeneration: Long,
        expectedDraftId: String, receipt: ImportCalendarSubmissionReceipt) = locked(owner) { scope ->
        val present = readLocked(owner, scope)
        if (present == null || present.generation != expectedGeneration || present.state.draftId != expectedDraftId ||
            present.calendarSubmission?.idempotencyKey != receipt.idempotencyKey ||
            present.state.upload?.ticket?.assetId != receipt.assetId || present.state.upload.ticket.uploadId != receipt.uploadId ||
            present.state.upload.serverVerified != true || readGeneratedLocked(scope) != null)
            throw ImportCheckpointFailure("checkpoint_conflict")
        val file = child("$scope.bin"); ensureRegularOrAbsent(file)
        if (file.exists() && !file.delete()) throw ImportCheckpointFailure("checkpoint_storage_unavailable")
    }

    private fun readLocked(owner: ImportOwner, scope: String): ImportDurableCheckpoint? {
        val file = child("$scope.bin")
        ensureRegularOrAbsent(file)
        if (!file.exists()) return null
        require(file.length() in 28..(ImportCheckpointCodec.MAX_BYTES + 128).toLong())
        val sealed = Files.newInputStream(file.toPath(), LinkOption.NOFOLLOW_LINKS).use { stream ->
            val output = java.io.ByteArrayOutputStream()
            val buffer = ByteArray(8192)
            while (true) {
                val count = stream.read(buffer); if (count < 0) break
                require(output.size() + count <= ImportCheckpointCodec.MAX_BYTES + 128)
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
        val plain = try { cipher.decrypt(scope, sealed) } finally { sealed.fill(0) }
        return try { ImportCheckpointCodec.decode(plain, owner) } finally { plain.fill(0) }
    }
    private fun readGeneratedLocked(scope: String): ImportGeneratedSourceIntent? {
        val file = child("$scope.generated.bin"); ensureRegularOrAbsent(file)
        if (!file.exists()) return null
        require(file.length() in 28..4096)
        val sealed = Files.newInputStream(file.toPath(), LinkOption.NOFOLLOW_LINKS).use { stream ->
            val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(512)
            while (true) { val count = stream.read(buffer); if (count < 0) break
                require(output.size() + count <= 4096); output.write(buffer, 0, count) }
            output.toByteArray()
        }
        require(sealed.size <= 4096)
        val plain = try { cipher.decrypt("$scope:generated", sealed) } finally { sealed.fill(0) }
        return try {
            val json = JSONObject(String(plain, Charsets.UTF_8))
            require(json.keys().asSequence().toSet() == setOf("calendarItemId", "revision", "idempotencyKey"))
            ImportGeneratedSourceIntent(json.getString("calendarItemId"), json.getLong("revision"), json.getString("idempotencyKey"))
        } finally { plain.fill(0) }
    }

    private fun <T> locked(owner: ImportOwner, action: (String) -> T): T {
        val scope = ownerScope(owner)
        val guard = locks.computeIfAbsent(root.path + "/" + scope) { Any() }
        return synchronized(guard) {
            try {
                require(root.canonicalFile == root && root.isDirectory && !Files.isSymbolicLink(root.toPath()))
                val lockFile = child("$scope.lock"); ensureRegularOrAbsent(lockFile)
                RandomAccessFile(lockFile, "rw").use { lock -> lock.channel.lock().use { action(scope) } }
            } catch (error: ImportCheckpointFailure) { throw error }
            catch (_: Exception) { throw ImportCheckpointFailure("checkpoint_storage_unavailable") }
        }
    }

    private fun child(name: String): File = File(root, name).also { require(it.parentFile == root) }
    private fun ensureRegularOrAbsent(file: File) {
        require(!Files.isSymbolicLink(file.toPath()) && (!file.exists() || file.isFile))
    }

    companion object {
        private val locks = ConcurrentHashMap<String, Any>()
        internal fun ownerScope(owner: ImportOwner): String = MessageDigest.getInstance("SHA-256")
            .digest(("calendar-import-checkpoint-v1\u0000" + owner.companyId + "\u0000" + owner.userId).toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
