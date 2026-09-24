package br.com.ia4tube.app.feature.calendar

import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class GeneratedCalendarVideoPlaybackContractTest {
    @Test fun firstExplicitTapCreatesAnAutoplayingPlayer() {
        val source = File("src/main/java/br/com/ia4tube/app/feature/calendar/GeneratedCalendarVideo.kt").readText()
        val consentButton = source.indexOf("!requested -> Button(onClick = { requested = true })")
        val playerBranch = source.indexOf("else -> GeneratedVideoPlayer(video, token")
        val playerCreation = source.indexOf("ExoPlayer.Builder(context)")
        val autoplay = source.indexOf("playWhenReady = true", playerCreation)
        val prepare = source.indexOf("player.prepare()", autoplay)

        assertTrue("Video player must remain behind the user's first tap", consentButton >= 0 && playerBranch > consentButton)
        assertTrue("The created player must start without a second tap", playerCreation > playerBranch && autoplay > playerCreation)
        assertTrue("Preparing the video must retain that autoplay intent", prepare > autoplay)
    }
}
