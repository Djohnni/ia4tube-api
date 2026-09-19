package br.com.ia4tube.app.feature.calendar.imports

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

internal data class ImportFormatChoice(val title: String, val detail: String, val configuration: ImportConfiguration)

/** No implicit music licence, music picker from Instagram, or third Feed publication for a shared Reel. */
internal fun importFormatChoices(kind: ImportMediaKind, audio: ImportAudioMode, trackId: String? = null): List<ImportFormatChoice> {
    if (kind == ImportMediaKind.VIDEO) return listOf(
        ImportFormatChoice("Reel", "Um Reel, também mostrado no Feed.", ImportConfiguration(setOf(ImportTarget.REEL), audio, shareToFeed = true)),
        ImportFormatChoice("Story", "Um vídeo vertical no Story.", ImportConfiguration(setOf(ImportTarget.STORY), audio)),
        ImportFormatChoice("Story e Reel", "Duas publicações independentes. O Reel também aparece no Feed.",
            ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), audio, shareToFeed = true)))
    if (audio == ImportAudioMode.MUSIC && trackId != null) return listOf(
        ImportFormatChoice("Story com música", "Vídeo de 15 segundos para Story.", ImportConfiguration(setOf(ImportTarget.STORY), audio, trackId, setOf(ImportTarget.STORY))),
        ImportFormatChoice("Reel com música", "Vídeo de 15 segundos, também mostrado no Feed.",
            ImportConfiguration(setOf(ImportTarget.REEL), audio, trackId, setOf(ImportTarget.REEL), true)),
        ImportFormatChoice("Story e Reel com música", "Duas publicações, com o mesmo vídeo preparado quando compatível.",
            ImportConfiguration(setOf(ImportTarget.STORY, ImportTarget.REEL), audio, trackId, setOf(ImportTarget.STORY, ImportTarget.REEL), true)),
        ImportFormatChoice("Foto no Feed e Story com música", "A foto do Feed permanece imagem; o Story é um vídeo separado de 15 segundos.",
            ImportConfiguration(setOf(ImportTarget.FEED, ImportTarget.STORY), audio, trackId, setOf(ImportTarget.STORY))))
    return listOf(
        ImportFormatChoice("Foto no Feed", "Imagem 4:5, sem música.", ImportConfiguration(setOf(ImportTarget.FEED), ImportAudioMode.NONE)),
        ImportFormatChoice("Foto no Story", "Imagem vertical, sem música.", ImportConfiguration(setOf(ImportTarget.STORY), ImportAudioMode.NONE)),
        ImportFormatChoice("Foto no Feed e Story", "Duas imagens preparadas nos enquadramentos de cada destino.",
            ImportConfiguration(setOf(ImportTarget.FEED, ImportTarget.STORY), ImportAudioMode.NONE)))
}

internal fun importScheduledAt(date: String, time: String, now: Long = System.currentTimeMillis()): Long? = runCatching {
    require(date.matches(Regex("\\d{4}-\\d{2}-\\d{2}")) && time.matches(Regex("([01]\\d|2[0-3]):[0-5]\\d")))
    LocalDate.parse(date).atTime(LocalTime.parse(time)).atZone(ZoneId.of("America/Sao_Paulo")).toInstant().toEpochMilli().also {
        require(it > now && it <= now + 180L * 24 * 60 * 60 * 1000)
    }
}.getOrNull()

internal fun importFinalAudioLabel(configuration: ImportConfiguration) = when (configuration.audioMode) {
    ImportAudioMode.NONE -> "Arquivo final sem música"
    ImportAudioMode.MUSIC -> "Música incorporada no arquivo preparado"
    ImportAudioMode.ORIGINAL -> "Áudio original do vídeo, se presente"
    ImportAudioMode.MUTED -> "Áudio removido do arquivo final"
}

/** Session-local evidence of rendered, checksum-verified variants. Never restored as an approval. */
internal class ImportPreviewReview {
    private var owner: ImportOwner? = null
    private var token: String? = null
    private var preview: ImportPrivatePreview? = null
    private val shown = mutableSetOf<String>()
    fun bind(owner: ImportOwner, token: String, value: ImportPrivatePreview?) {
        val previous = preview
        if (this.owner != owner || this.token != token || previous?.assetId != value?.assetId ||
            previous?.mediaRevision != value?.mediaRevision || previous?.previewDigest != value?.previewDigest ||
            previous?.variants?.map { it.target to it.sha256 } != value?.variants?.map { it.target to it.sha256 }) shown.clear()
        this.owner = owner; this.token = token; preview = value
    }
    fun rendered(target: String) { if (preview?.variants?.any { it.target == target } == true) shown.add(target) }
    fun failed(target: String) { shown.remove(target) }
    fun clear() { shown.clear(); preview = null; owner = null; token = null }
    fun verifiedTargets(): Set<String> = shown.toSet()
    fun complete(): Boolean = preview?.variants?.let { it.isNotEmpty() && it.all { part -> part.target in shown } } == true
}
