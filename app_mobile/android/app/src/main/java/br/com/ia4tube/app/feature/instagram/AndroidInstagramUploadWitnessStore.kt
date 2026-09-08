package br.com.ia4tube.app.feature.instagram

/** Private metadata only; existing backup and device-transfer rules exclude all shared preferences. */
class AndroidInstagramUploadWitnessStore(context: android.content.Context) : InstagramUploadWitnessStore {
    private val preferences = context.applicationContext.getSharedPreferences(
        "ia4tube_instagram_upload_witnesses_v1", android.content.Context.MODE_PRIVATE
    )
    private val store = EncodedInstagramUploadWitnessStore(
        readValue = { key -> preferences.getString(key, null) },
        writeValue = { key, value ->
            val editor = preferences.edit()
            if (value == null) editor.remove(key) else editor.putString(key, value)
            editor.commit()
        },
        guard = guard
    )

    override fun read(contextKey: String): InstagramUploadWitness? = store.read(contextKey)
    override fun create(contextKey: String, witness: InstagramUploadWitness): Boolean = store.create(contextKey, witness)
    override fun update(contextKey: String, witness: InstagramUploadWitness): Boolean = store.update(contextKey, witness)
    override fun clearResolved(contextKey: String, id: String): Boolean = store.clearResolved(contextKey, id)

    private companion object {
        val guard = InstagramUploadStorageGuard()
    }
}
