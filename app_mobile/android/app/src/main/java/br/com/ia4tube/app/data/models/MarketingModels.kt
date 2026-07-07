package br.com.ia4tube.app.data.models

data class MarketingVideo(
    val active: Boolean,
    val id: String,
    val context: String,
    val title: String,
    val description: String,
    val urlVideo: String,
    val thumbnail: String,
    val autoplay: Boolean,
    val jaVisto: Boolean,
    val durationSeconds: Int,
    val version: String,
    val fallback: String
)
