package br.com.ia4tube.app.feature.instagram

/** Separate private metadata ledger; backup exclusion already covers every shared-preference file. */
class AndroidInstagramAuthorizationWitnessStore(context: android.content.Context) : InstagramAuthorizationWitnessStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "ia4tube_instagram_authorization_witnesses_v1", android.content.Context.MODE_PRIVATE
    )
    private val store = EncodedInstagramAuthorizationWitnessStore(
        readValue = { key -> preferences.getString(key, null) },
        writeValue = { key, value ->
            val editor = preferences.edit()
            if (value == null) editor.remove(key) else editor.putString(key, value)
            editor.commit()
        },
        lock = lock
    )

    override fun read(contextKey: String): InstagramAuthorizationWitness? = store.read(contextKey)
    override fun create(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = store.create(contextKey, witness)
    override fun update(contextKey: String, witness: InstagramAuthorizationWitness): Boolean = store.update(contextKey, witness)
    override fun clear(contextKey: String, id: String): Boolean = store.clear(contextKey, id)

    private companion object {
        val lock = Any()
    }
}
