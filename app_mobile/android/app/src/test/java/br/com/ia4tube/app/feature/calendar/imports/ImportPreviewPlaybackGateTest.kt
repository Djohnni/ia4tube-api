package br.com.ia4tube.app.feature.calendar.imports

import org.junit.Assert.*
import org.junit.Test

class ImportPreviewPlaybackGateTest {
    @Test fun `switching item releases previous player before creating active lease`() {
        val gate = ImportPreviewPlaybackGate(); var firstStops = 0; var secondStops = 0
        val first = gate.activate { firstStops++ }
        val second = gate.activate { secondStops++ }
        assertEquals(1, firstStops); assertEquals(0, secondStops)
        gate.release(first); assertEquals(0, secondStops)
        gate.release(second); assertEquals(1, secondStops)
    }
    @Test fun `leave session stop and disposal release once and cannot revive old player`() {
        val gate = ImportPreviewPlaybackGate(); var stops = 0
        val lease = gate.activate { stops++ }
        gate.clear(); gate.release(lease); gate.clear()
        assertEquals(1, stops)
    }
    @Test fun `rapid item changes never retain two live playback resources`() {
        val gate = ImportPreviewPlaybackGate(); var live = 0; var stops = 0
        repeat(25) {
            val lease = gate.activate { live--; stops++ }
            live++; assertEquals(1, live)
            if (it % 2 == 0) { gate.release(lease); assertEquals(0, live) }
        }
        gate.clear(); assertEquals(0, live); assertEquals(25, stops)
    }
}
