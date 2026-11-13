package br.com.ia4tube.app.feature.assistant

import br.com.ia4tube.app.BuildConfig
import br.com.ia4tube.app.data.models.UploadFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

internal data class AssistantMessage(val id: String, val role: String, val text: String, val photos: List<String>)
internal data class AssistantItem(val id: String, val photoId: String, val kind: String, val title: String,
    val caption: String, val imageText: String, val date: String, val time: String, val destination: String)
internal data class AssistantDraft(val id: String, val version: Int, val items: List<AssistantItem>)
internal data class AssistantCampaign(val id: String, val status: String, val sent: Int, val total: Int, val afterMessageId: String = "")
internal data class AssistantSnapshot(val messages: List<AssistantMessage>, val draft: AssistantDraft?,
    val campaigns: List<AssistantCampaign>, val images: Int, val videos: Int, val connected: Boolean,
    val hasLogo: Boolean, val used: Int, val limit: Int, val budgetReached: Boolean, val businessType: String = "")
internal class AssistantException(val code: String) : Exception(code)

internal fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
internal fun parseAssistantSnapshot(j: JSONObject): AssistantSnapshot {
    if (!j.optBoolean("ok")) throw AssistantException("assistant_unavailable")
    fun optional(j: JSONObject, k: String) = if (j.isNull(k)) "" else j.optString(k)
    val draft = j.optJSONObject("draft")?.let { d -> AssistantDraft(d.getString("id"), d.getInt("version"),
        d.getJSONArray("items").objects().map { i -> AssistantItem(i.getString("id"),i.getString("photoId"),i.getString("kind"),
            i.getString("title"),i.getString("caption"),optional(i,"imageText"),optional(i,"date"),optional(i,"time"),i.getString("destination")) }) }
    return AssistantSnapshot(j.optJSONArray("messages")?.objects()?.map { m ->
        val photos=m.optJSONArray("photoIds") ?: JSONArray()
        AssistantMessage(m.getString("id"),m.getString("role"),m.getString("text"),(0 until photos.length()).map { photos.getString(it) })
    }.orEmpty(),draft,j.optJSONArray("campaigns")?.objects()?.map { AssistantCampaign(it.getString("id"),it.getString("status"),it.getInt("sent"),it.getInt("total"),it.optString("afterMessageId")) }.orEmpty(),
        j.optInt("images"),j.optInt("videos"),j.optBoolean("connected"),j.optBoolean("hasLogo"),j.optInt("messagesUsed"),j.optInt("messageLimit",20),j.optBoolean("budgetReached"),j.optString("businessType"))
}

internal class AssistantClient {
    private val http=OkHttpClient.Builder().connectTimeout(30,TimeUnit.SECONDS).readTimeout(110,TimeUnit.SECONDS)
        .writeTimeout(90,TimeUnit.SECONDS).followRedirects(false).followSslRedirects(false).retryOnConnectionFailure(false).build()
    private fun request(token:String, suffix:String, body:RequestBody?=null): Request {
        if(token.isBlank())throw AssistantException("assistant_session_required")
        return Request.Builder().url(BuildConfig.API_BASE.trimEnd('/')+"/empresa/assistente"+suffix)
            .header("Authorization","Bearer $token").header("Cache-Control","no-store")
            .apply { if(body!=null)post(body) }.build()
    }
    private fun json(value:JSONObject)=value.toString().toRequestBody("application/json; charset=utf-8".toMediaType())
    private suspend fun execute(req:Request)=withContext(Dispatchers.IO) {
        try { http.newCall(req).execute().use { response ->
            val raw=response.body?.string().orEmpty()
            if(raw.length>2*1024*1024)throw AssistantException("assistant_unavailable")
            val j=runCatching { JSONObject(raw) }.getOrElse { throw AssistantException("assistant_unavailable") }
            if(!response.isSuccessful||!j.optBoolean("ok"))throw AssistantException(j.optString("code","assistant_unavailable"))
            j
        } }catch(e:AssistantException){throw e}catch(_:Exception){throw AssistantException("assistant_connection_unconfirmed")}
    }
    suspend fun state(token:String)=parseAssistantSnapshot(execute(request(token,"/")))
    suspend fun upload(token:String,id:String,file:File) {
        val body=MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("id",id)
            .addFormDataPart("image","foto.jpg",file.readBytes().toRequestBody("image/jpeg".toMediaType())).build()
        val result=execute(request(token,"/photos",body));if(result.optString("photoId")!=id)throw AssistantException("assistant_photo_invalid")
    }
    suspend fun message(token:String,id:String,text:String,photos:List<String>)=parseAssistantSnapshot(execute(request(token,"/messages",
        json(JSONObject().put("requestId",id).put("message",text).put("photoIds",JSONArray(photos))))))
    suspend fun report(token:String,id:String){execute(request(token,"/report",json(JSONObject().put("messageId",id))))}
    suspend fun saveLogo(token:String,file:UploadFile) {
        if(token.isBlank())throw AssistantException("assistant_session_required")
        if(file.bytes.isEmpty()||file.bytes.size>5*1024*1024||file.contentType !in setOf("image/png","image/jpeg","image/webp"))throw AssistantException("assistant_photo_invalid")
        // An empty profile patch changes only the logo, using the existing profile lock and validation.
        val body=MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("profile","{}")
            .addFormDataPart("logo",file.fileName,file.bytes.toRequestBody(file.contentType.toMediaType())).build()
        val result=execute(Request.Builder().url(BuildConfig.API_BASE.trimEnd('/')+"/company/profile")
            .header("Authorization","Bearer $token").header("Cache-Control","no-store").put(body).build())
        if(result.optJSONObject("profile")?.optBoolean("has_logo")!=true)throw AssistantException("assistant_logo_required")
    }
    suspend fun confirm(token:String,draft:AssistantDraft,items:List<AssistantItem>):String {
        val rows=JSONArray();items.forEach { rows.put(JSONObject().put("id",it.id).put("date",it.date).put("time",it.time).put("destination",it.destination).put("kind",it.kind)) }
        return execute(request(token,"/confirm",json(JSONObject().put("draftId",draft.id).put("version",draft.version).put("confirmed",true).put("items",rows)))).getString("campaignId")
    }
    suspend fun photo(token:String,id:String)=withContext(Dispatchers.IO) {
        http.newCall(request(token,"/photos/$id")).execute().use { r ->
            if(!r.isSuccessful)throw AssistantException("assistant_photo_not_found")
            r.body?.bytes()?.takeIf { it.size<=10*1024*1024 } ?: throw AssistantException("assistant_photo_invalid")
        }
    }
}
