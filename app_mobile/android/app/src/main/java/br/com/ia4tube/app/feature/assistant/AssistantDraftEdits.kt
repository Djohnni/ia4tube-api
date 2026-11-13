package br.com.ia4tube.app.feature.assistant

import org.json.JSONArray
import org.json.JSONObject

/** Only editable fields are stored, scoped to this account's draft id AND revision. */
internal fun assistantSaveEdits(draft:AssistantDraft):JSONObject = JSONObject()
    .put("draftId",draft.id).put("version",draft.version).put("items",JSONArray().apply{
        draft.items.forEach { put(JSONObject().put("id",it.id).put("kind",it.kind).put("imageText",it.imageText)
            .put("date",it.date).put("time",it.time).put("destination",it.destination)) }
    })

internal fun assistantRestoreEdits(draft:AssistantDraft,saved:JSONObject):AssistantDraft {
    if(saved.optString("draftId")!=draft.id||saved.optInt("version",-1)!=draft.version)return draft
    val rows=saved.optJSONArray("items")?.objects().orEmpty()
    if(rows.size!=draft.items.size||rows.map{it.optString("id")}.toSet()!=draft.items.map{it.id}.toSet())return draft
    return draft.copy(items=draft.items.map { item ->
        val row=rows.single{it.optString("id")==item.id}
        val kind=row.optString("kind");val destination=row.optString("destination")
        if(kind !in setOf("image","video")||destination !in setOf("feed","story","both"))item
        else item.copy(kind=kind,imageText=row.optString("imageText").take(300),date=row.optString("date"),
            time=row.optString("time"),destination=destination)
    })
}
