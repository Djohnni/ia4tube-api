package br.com.ia4tube.app.data.models

data class SupportMessage(
    val id: String,
    val text: String,
    val sender: SupportSender,
    val createdAt: String
)

enum class SupportSender {
    Client,
    Support
}

data class SendSupportMessageResponse(
    val responseText: String,
    val humanMode: Boolean,
    val conversationId: String
)
