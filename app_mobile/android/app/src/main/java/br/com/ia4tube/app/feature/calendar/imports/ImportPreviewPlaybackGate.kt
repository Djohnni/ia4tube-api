package br.com.ia4tube.app.feature.calendar.imports

/** UI-thread adapter gate: at most one live private-preview player, with idempotent release. */
internal class ImportPreviewPlaybackGate {
    internal class Lease internal constructor()
    private var active: Pair<Lease, () -> Unit>? = null
    @Synchronized fun activate(stopAndRelease: () -> Unit): Lease {
        clear()
        return Lease().also { active = it to stopAndRelease }
    }
    @Synchronized fun release(lease: Lease) { if (active?.first === lease) clear() }
    @Synchronized fun clear() {
        val current = active; active = null
        current?.second?.invoke()
    }
}

internal object ActiveImportPreviewPlayback { val gate = ImportPreviewPlaybackGate() }
