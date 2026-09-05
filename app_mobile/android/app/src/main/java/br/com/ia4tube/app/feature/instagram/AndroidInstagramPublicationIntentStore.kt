package br.com.ia4tube.app.feature.instagram

class AndroidInstagramPublicationIntentStore(context: android.content.Context) : InstagramPublicationIntentStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "ia4tube_instagram_publication_intents_v1", android.content.Context.MODE_PRIVATE
    )

    override fun read(contextKey: String): InstagramPublicationIntent? = synchronized(lock) {
        val encoded = preferences.getString(key(contextKey), null) ?: return@synchronized null
        InstagramIntentCodec.decode(encoded)
    }

    override fun create(contextKey: String, intent: InstagramPublicationIntent): Boolean = synchronized(lock) {
        val storageKey = key(contextKey)
        if (preferences.contains(storageKey)) return@synchronized false
        if (!InstagramIntentPolicy.hasAccountBinding(intent)) return@synchronized false
        preferences.edit().putString(storageKey, InstagramIntentCodec.encode(intent)).commit()
    }

    override fun update(contextKey: String, intent: InstagramPublicationIntent): Boolean = synchronized(lock) {
        val previous = read(contextKey) ?: return@synchronized false
        if (!InstagramIntentPolicy.canUpdate(previous, intent)) return@synchronized false
        preferences.edit().putString(key(contextKey), InstagramIntentCodec.encode(intent)).commit()
    }

    override fun removeConfirmed(contextKey: String, clientRequestId: String): Boolean = synchronized(lock) {
        val previous = read(contextKey) ?: return@synchronized false
        if (!previous.confirmed || previous.clientRequestId != clientRequestId) return@synchronized false
        preferences.edit().remove(key(contextKey)).commit()
    }

    private fun key(contextKey: String): String {
        check(Regex("[0-9a-f]{64}").matches(contextKey)) { "Invalid publication context" }
        return "intent.$contextKey"
    }

    private companion object {
        val lock = Any()
    }
}
