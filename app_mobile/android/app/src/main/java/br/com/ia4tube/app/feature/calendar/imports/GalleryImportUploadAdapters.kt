package br.com.ia4tube.app.feature.calendar.imports

import android.net.Uri

/** Injectable boundaries; production implementations keep URI and grants private. */
internal interface GalleryImportUploadSource {
    fun retain(uri: String): Boolean
    suspend fun inspect(uri: String): ImportSelection
    suspend fun part(uri: String, selection: ImportSelection, index: Int): ByteArray
}

internal class AndroidGalleryImportUploadSource(private val source: AndroidImportSource) : GalleryImportUploadSource {
    override fun retain(uri: String) = source.retainReadPermission(Uri.parse(uri))
    override suspend fun inspect(uri: String) = source.inspect(Uri.parse(uri))
    override suspend fun part(uri: String, selection: ImportSelection, index: Int) = source.part(Uri.parse(uri), selection, index)
}

internal interface GalleryImportUploadTransport {
    suspend fun capabilities(): ImportCapabilities
    suspend fun start(owner: ImportOwner, media: ImportSelection, key: String): ImportUploadRecord
    suspend fun resume(owner: ImportOwner, uploadId: String): ImportUploadRecord
    suspend fun complete(owner: ImportOwner, uploadId: String): ImportUploadRecord
    suspend fun cancel(owner: ImportOwner, uploadId: String): ImportUploadRecord
    suspend fun authorizePart(owner: ImportOwner, upload: ImportUploadRecord, part: Int, checksums: ImportPartChecksums): ImportPartAuthorization
    suspend fun resolvePart(owner: ImportOwner, authorization: ImportPartAuthorization, checksums: ImportPartChecksums): ImportPartGrant
    suspend fun putPart(grant: ImportPartGrant, bytes: ByteArray, progress: (Long, Long) -> Unit)
}

internal class HttpGalleryImportUploadTransport(private val api: GalleryImportHttpApi) : GalleryImportUploadTransport {
    override suspend fun capabilities() = api.capabilities()
    override suspend fun start(owner: ImportOwner, media: ImportSelection, key: String) = api.start(owner, media, key)
    override suspend fun resume(owner: ImportOwner, uploadId: String) = api.resume(owner, uploadId)
    override suspend fun complete(owner: ImportOwner, uploadId: String) = api.complete(owner, uploadId)
    override suspend fun cancel(owner: ImportOwner, uploadId: String) = api.cancel(owner, uploadId)
    override suspend fun authorizePart(owner: ImportOwner, upload: ImportUploadRecord, part: Int, checksums: ImportPartChecksums) = api.authorizePart(owner, upload, part, checksums)
    override suspend fun resolvePart(owner: ImportOwner, authorization: ImportPartAuthorization, checksums: ImportPartChecksums) = api.resolvePart(owner, authorization, checksums)
    override suspend fun putPart(grant: ImportPartGrant, bytes: ByteArray, progress: (Long, Long) -> Unit) = api.putPart(grant, bytes, progress)
}
