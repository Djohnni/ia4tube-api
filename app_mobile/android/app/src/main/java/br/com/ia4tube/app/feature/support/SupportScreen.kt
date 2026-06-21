package br.com.ia4tube.app.feature.support

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import br.com.ia4tube.app.R
import br.com.ia4tube.app.data.models.SupportMessage
import br.com.ia4tube.app.data.models.SupportSender
import br.com.ia4tube.app.ui.components.ScreenScaffold
import br.com.ia4tube.app.ui.text.asString

@Composable
fun SupportScreen(
    viewModel: SupportViewModel,
    onBack: () -> Unit
) {
    val state by viewModel.uiState.collectAsState()
    val listState = rememberLazyListState()

    LaunchedEffect(state.scrollVersion, state.messages.size) {
        if (state.messages.isNotEmpty()) {
            listState.animateScrollToItem(state.messages.lastIndex)
        }
    }

    ScreenScaffold {
        Column(modifier = Modifier.fillMaxSize()) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(stringResource(R.string.support_title), style = MaterialTheme.typography.headlineSmall)
                Row {
                    OutlinedButton(
                        enabled = !state.loading && !state.refreshing,
                        onClick = viewModel::refreshManual
                    ) {
                        Text(stringResource(R.string.common_update))
                    }
                    OutlinedButton(onClick = onBack) {
                        Text(stringResource(R.string.common_back))
                    }
                }
            }

            Spacer(modifier = Modifier.height(16.dp))

            if (state.refreshing) {
                RefreshingState()
                Spacer(modifier = Modifier.height(12.dp))
            }

            when {
                state.loading -> LoadingState()
                state.messages.isEmpty() -> EmptyState()
                else -> MessagesList(
                    modifier = Modifier.weight(1f),
                    messages = state.messages,
                    listState = listState
                )
            }

            state.error?.let { error ->
                Spacer(modifier = Modifier.height(10.dp))
                Text(error.asString(), color = MaterialTheme.colorScheme.error)
            }

            Spacer(modifier = Modifier.height(12.dp))
            OutlinedTextField(
                modifier = Modifier.fillMaxWidth(),
                value = state.draft,
                onValueChange = viewModel::updateDraft,
                enabled = !state.sending,
                minLines = 2,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(
                    onSend = { viewModel.send() }
                ),
                label = { Text(stringResource(R.string.support_message_hint)) }
            )
            Spacer(modifier = Modifier.height(10.dp))
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = !state.sending,
                onClick = viewModel::send
            ) {
                if (state.sending) {
                    CircularProgressIndicator()
                } else {
                    Text(stringResource(R.string.common_send))
                }
            }
            Spacer(modifier = Modifier.height(24.dp))
        }
    }
}

@Composable
private fun RefreshingState() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator(modifier = Modifier.size(18.dp))
        Spacer(modifier = Modifier.padding(horizontal = 5.dp))
        Text(stringResource(R.string.support_updating), style = MaterialTheme.typography.bodySmall)
    }
}

@Composable
private fun LoadingState() {
    Row(verticalAlignment = Alignment.CenterVertically) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.padding(horizontal = 6.dp))
        Text(stringResource(R.string.support_loading))
    }
}

@Composable
private fun EmptyState() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)
    ) {
        Text(
            modifier = Modifier.padding(16.dp),
            text = stringResource(R.string.support_empty),
            style = MaterialTheme.typography.titleMedium
        )
    }
}

@Composable
private fun MessagesList(
    modifier: Modifier,
    messages: List<SupportMessage>,
    listState: LazyListState
) {
    LazyColumn(
        modifier = modifier,
        state = listState,
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        items(messages, key = { it.id }) { message ->
            SupportMessageCard(message = message)
        }
    }
}

@Composable
private fun SupportMessageCard(message: SupportMessage) {
    val isClient = message.sender == SupportSender.Client
    val background = if (isClient) {
        MaterialTheme.colorScheme.primaryContainer
    } else {
        MaterialTheme.colorScheme.surface
    }
    val sender = if (isClient) {
        stringResource(R.string.support_sender_client)
    } else {
        stringResource(R.string.support_sender_team)
    }

    Row(
        modifier = Modifier
            .fillMaxWidth(),
        horizontalArrangement = if (isClient) Arrangement.End else Arrangement.Start
    ) {
        Column(
            modifier = Modifier
                .widthIn(max = 320.dp)
                .background(background, RoundedCornerShape(8.dp))
                .padding(14.dp)
        ) {
            Text(sender, style = MaterialTheme.typography.labelLarge)
            Spacer(modifier = Modifier.height(4.dp))
            Text(message.text)
            if (message.createdAt.isNotBlank()) {
                Spacer(modifier = Modifier.height(6.dp))
                Text(
                    text = message.createdAt,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodySmall
                )
            }
        }
    }
}
