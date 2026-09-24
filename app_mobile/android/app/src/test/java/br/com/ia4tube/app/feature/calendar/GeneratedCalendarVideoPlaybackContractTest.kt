package br.com.ia4tube.app.feature.calendar

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GeneratedCalendarVideoPlaybackContractTest {
    @Test fun visibleVideoDoesNotFetchPrivateMp4UntilTapped() {
        val source = File("src/main/java/br/com/ia4tube/app/feature/calendar/GeneratedCalendarVideo.kt").readText()
        val inactiveBranch = source.indexOf("!active || !foreground -> Text")
        val playerBranch = source.indexOf("else -> GeneratedVideoPlayer(video, token, requested")
        val playerCreation = source.indexOf("ExoPlayer.Builder(context)")
        val paused = source.indexOf("playWhenReady = false", playerCreation)
        val listener = source.indexOf("player.addListener(listener)", paused)
        val button = source.indexOf("Button(onClick = {", listener)
        val prepare = source.indexOf("player.prepare()", button)

        assertTrue("Only the active, foreground item should create a player", inactiveBranch >= 0 && playerBranch > inactiveBranch)
        assertTrue("The player starts paused", playerCreation > playerBranch && paused > playerCreation)
        assertTrue("The first tap prepares the video", button > listener && prepare > button)
        assertFalse("Merely opening the gallery must not fetch the MP4", source.substring(listener, button).contains("player.prepare()"))
    }

    @Test fun firstTapStartsPlaybackAndKeepsThePosterLabel() {
        val source = File("src/main/java/br/com/ia4tube/app/feature/calendar/GeneratedCalendarVideo.kt").readText()
        val gallery = File("src/main/java/br/com/ia4tube/app/feature/calendar/CalendarGallery.kt").readText()
        assertTrue("The existing button must request playback", source.contains("onRequest()") && source.contains("Text(\"Reproduzir vídeo\")"))
        assertTrue("One tap must play the already prepared player", source.contains("if (requested) player.play() else player.pause()"))
        assertTrue("The poster must identify repeated video files", gallery.contains("posterLabel = posterLabel") &&
            gallery.contains("art.caption.lineSequence().firstOrNull"))
    }
}
