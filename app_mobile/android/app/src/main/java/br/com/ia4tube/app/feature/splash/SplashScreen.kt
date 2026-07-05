package br.com.ia4tube.app.feature.splash

import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.ui.components.ScreenScaffold

@Composable
fun SplashScreen(
    viewModel: SplashViewModel,
    onGoLogin: () -> Unit,
    onGoHome: () -> Unit
) {
    val destination by viewModel.destination.collectAsState()

    LaunchedEffect(destination) {
        when (destination) {
            SplashDestination.Home -> onGoHome()
            SplashDestination.Login -> onGoLogin()
            SplashDestination.Loading -> Unit
        }
    }

    ScreenScaffold(containerColor = SplashBackground) {
        Column(
            modifier = Modifier.fillMaxSize(),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Image(
                painter = painterResource(id = R.drawable.ic_launcher_foreground),
                contentDescription = null,
                modifier = Modifier.size(112.dp)
            )
            Spacer(modifier = Modifier.height(18.dp))
            Text(
                text = stringResource(R.string.app_name),
                color = SplashText,
                style = MaterialTheme.typography.headlineLarge
            )
            Spacer(modifier = Modifier.height(6.dp))
            Text(
                text = stringResource(R.string.splash_tagline),
                color = SplashMutedText,
                style = MaterialTheme.typography.bodyMedium
            )
            Spacer(modifier = Modifier.height(18.dp))
            CircularProgressIndicator(color = SplashGold)
        }
    }
}

private val SplashBackground = Color(0xFF050403)
private val SplashText = Color(0xFFFFF7DC)
private val SplashMutedText = Color(0xFFD8C27A)
private val SplashGold = Color(0xFFFFD45A)
