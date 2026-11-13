package br.com.ia4tube.app.feature.assistant

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.util.AtomicFile
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import br.com.ia4tube.app.data.repository.authenticatedAccountFromJwt
import br.com.ia4tube.app.core.upload.AndroidFileReader
import br.com.ia4tube.app.data.models.ApiResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.UUID

internal data class AssistantAttachment(val id:String,val file:File)
internal data class AssistantUiState(val snapshot:AssistantSnapshot?=null,val busy:Boolean=false,val loading:Boolean=true,
    val input:String="",val attachments:List<AssistantAttachment> = emptyList(),val error:String?=null,val retryPending:Boolean=false)

internal class AssistantViewModel(private val context:Context,private val currentToken:()->String):ViewModel() {
    private val owner=authenticatedAccountFromJwt(currentToken())
    private val client=AssistantClient()
    private val directory=File(context.filesDir,"assistant/"+MessageDigest.getInstance("SHA-256").digest(owner.toByteArray()).joinToString(""){"%02x".format(it)})
    private val mutable=MutableStateFlow(AssistantUiState())
    val state=mutable.asStateFlow()
    private fun token():String { val t=currentToken();if(owner.isBlank()||authenticatedAccountFromJwt(t)!=owner)throw AssistantException("assistant_session_required");return t }
    private fun saveJson(file:File,value:String){
        val atomic=AtomicFile(file);val stream=atomic.startWrite()
        try{stream.write(value.toByteArray(Charsets.UTF_8));atomic.finishWrite(stream)}
        catch(e:Exception){atomic.failWrite(stream);throw e}
    }
    init { viewModelScope.launch { restore();refresh() } }
    private fun persistAttachments() {
        directory.mkdirs();val rows=JSONArray();mutable.value.attachments.forEach { rows.put(it.id) }
        saveJson(File(directory,"attachments.json"),rows.toString())
    }
    private fun restore() {
        runCatching {
            val f=File(directory,"attachments.json");if(f.isFile){val a=JSONArray(f.readText());mutable.update { s -> s.copy(attachments=(0 until a.length()).mapNotNull { i ->
                val id=a.getString(i);if(!id.matches(Regex("[a-f0-9-]{36}")))null else File(directory,"$id.jpg").takeIf{it.isFile}?.let{AssistantAttachment(id,it)} }) }}
            val pending=File(directory,"pending.json");if(pending.isFile){
                mutable.update{it.copy(retryPending=true)}
                val j=JSONObject(AtomicFile(pending).openRead().bufferedReader().use{it.readText()});mutable.update { it.copy(input=j.optString("message")) }
            }
        }
    }
    fun input(value:String) { if(!mutable.value.retryPending)mutable.update { it.copy(input=value.take(2000)) } }
    suspend fun refresh() {
        try { val t=token();val result=client.state(t);token();mutable.update { it.copy(snapshot=result,loading=false,error=null) } }
        catch(e:Exception){mutable.update{it.copy(loading=false,error=errorText(e))}}
    }
    fun reload(){viewModelScope.launch{refresh()}}
    fun saveLogo(uri:Uri) {
        if(mutable.value.busy)return
        viewModelScope.launch {
            mutable.update { it.copy(busy=true,error=null) }
            try {
                val t=token()
                val file=when(val loaded=AndroidFileReader(context).readUploadFile(uri)) {
                    is ApiResult.Success -> loaded.value
                    is ApiResult.Failure -> throw AssistantException("assistant_photo_invalid")
                }
                token();client.saveLogo(t,file);token()
                mutable.update { it.copy(snapshot=it.snapshot?.copy(hasLogo=true)) };refresh()
            }catch(e:Exception){mutable.update { it.copy(error=errorText(e)) }}finally{mutable.update { it.copy(busy=false) }}
        }
    }
    fun report(id:String){viewModelScope.launch{
        try{client.report(token(),id);token();mutable.update{it.copy(error="Resposta sinalizada. Obrigado por avisar.")}}
        catch(e:Exception){mutable.update{it.copy(error=errorText(e))}}
    }}
    fun attach(uri:Uri) = attachAll(listOf(uri))
    fun attachAll(uris:List<Uri>) {
        if(mutable.value.busy||mutable.value.retryPending)return
        viewModelScope.launch {
            mutable.update { it.copy(busy=true,error=null) }
            try {
                token();if(uris.size+mutable.value.attachments.size>4)throw AssistantException("assistant_photo_limit")
                for(uri in uris){
                    val attachment=withContext(Dispatchers.IO){normalize(uri)};token()
                    mutable.update { it.copy(attachments=it.attachments+attachment) };persistAttachments()
                }
            }catch(e:Exception){mutable.update { it.copy(error=errorText(e)) }}finally{mutable.update { it.copy(busy=false) }}
        }
    }
    fun continueConversation(){
        if(mutable.value.busy)return
        File(directory,"pending.json").delete()
        mutable.update { it.copy(retryPending=false,input="",attachments=emptyList(),error=null) };persistAttachments()
    }
    fun remove(id:String){if(!mutable.value.busy&&!mutable.value.retryPending){mutable.update { it.copy(attachments=it.attachments.filterNot{p->p.id==id}) };persistAttachments()}}
    fun send(prefill:String?=null) {
        if(mutable.value.busy)return
        val before=mutable.value
        val message=prefill?:before.input
        if(message.isBlank()&&before.attachments.isEmpty())return
        viewModelScope.launch {
            mutable.update { it.copy(busy=true,error=null) }
            try {
                val t=token();directory.mkdirs();val pending=File(directory,"pending.json")
                val attempt=if(pending.isFile)JSONObject(pending.readText()) else JSONObject().put("id",UUID.randomUUID().toString())
                    .put("message",message).put("photoIds",JSONArray(before.attachments.map{it.id}))
                saveJson(pending,attempt.toString())
                mutable.update { it.copy(retryPending=true) }
                for(p in before.attachments){client.upload(t,p.id,p.file);token()}
                val ids=attempt.getJSONArray("photoIds");val result=client.message(t,attempt.getString("id"),attempt.getString("message"),(0 until ids.length()).map{ids.getString(it)})
                token();pending.delete();mutable.update { it.copy(snapshot=result,input="",attachments=emptyList(),retryPending=false) };persistAttachments()
            }catch(e:Exception){mutable.update { it.copy(error=errorText(e)) }}finally{mutable.update { it.copy(busy=false) }}
        }
    }
    fun confirm(draft:AssistantDraft,items:List<AssistantItem>,onConfirmed:()->Unit) {
        if(mutable.value.busy)return
        viewModelScope.launch {
            mutable.update { it.copy(busy=true,error=null) }
            try {
                val t=token();client.confirm(t,draft,items);token();onConfirmed();refresh()
                mutable.update { it.copy(busy=false) }
                viewModelScope.launch { for(n in 0 until 12){
                    if(mutable.value.snapshot?.campaigns?.none{it.status=="queued"}==true)break
                    delay(5000);refresh()
                } }
            }catch(e:Exception){mutable.update { it.copy(error=errorText(e)) }}finally{mutable.update { it.copy(busy=false) }}
        }
    }
    suspend fun photoBytes(id:String)=client.photo(token(),id)
    private fun normalize(uri:Uri):AssistantAttachment {
        directory.mkdirs();val id=UUID.randomUUID().toString();val raw=File(directory,"$id-source.tmp")
        try {
            context.contentResolver.openInputStream(uri)?.use{input->raw.outputStream().use{out->
                val buffer=ByteArray(32768);var total=0;while(true){val n=input.read(buffer);if(n<0)break;total+=n;if(total>20*1024*1024)throw AssistantException("assistant_photo_invalid");out.write(buffer,0,n)}
            }}?:throw AssistantException("assistant_photo_invalid")
            val bounds=BitmapFactory.Options().apply{inJustDecodeBounds=true};BitmapFactory.decodeFile(raw.path,bounds)
            if(bounds.outWidth<=0||bounds.outHeight<=0||bounds.outWidth.toLong()*bounds.outHeight>100_000_000)throw AssistantException("assistant_photo_invalid")
            var sample=1;while(maxOf(bounds.outWidth,bounds.outHeight)/sample>2400)sample*=2
            val bitmap=BitmapFactory.decodeFile(raw.path,BitmapFactory.Options().apply{inSampleSize=sample})?:throw AssistantException("assistant_photo_invalid")
            val exif=runCatching{ExifInterface(raw.path).getAttributeInt(ExifInterface.TAG_ORIENTATION,1)}.getOrDefault(1)
            val matrix=Matrix().apply{when(exif){2->setScale(-1f,1f);3->setRotate(180f);4->setScale(1f,-1f);5->{setRotate(90f);postScale(-1f,1f)};6->setRotate(90f);7->{setRotate(-90f);postScale(-1f,1f)};8->setRotate(-90f)}}
            val rotated=Bitmap.createBitmap(bitmap,0,0,bitmap.width,bitmap.height,matrix,true)
            val scale=minOf(1f,1600f/maxOf(rotated.width,rotated.height))
            val resized=if(scale<1)Bitmap.createScaledBitmap(rotated,(rotated.width*scale).toInt().coerceAtLeast(1),(rotated.height*scale).toInt().coerceAtLeast(1),true)else rotated
            val output=ByteArrayOutputStream();resized.compress(Bitmap.CompressFormat.JPEG,84,output)
            if(resized!==rotated)resized.recycle();if(rotated!==bitmap)rotated.recycle();bitmap.recycle()
            if(output.size()>2*1024*1024)throw AssistantException("assistant_photo_invalid")
            val target=File(directory,"$id.jpg");target.writeBytes(output.toByteArray());return AssistantAttachment(id,target)
        }finally{raw.delete()}
    }
}

internal fun errorText(error:Exception):String=when((error as? AssistantException)?.code){
    "assistant_unavailable"->"O assistente ainda não está disponível para esta conta. Seus outros recursos continuam funcionando."
    "assistant_session_required","social_session_login_required"->"Entre novamente na sua conta."
    "assistant_logo_required"->"Escolha a logo da empresa para continuar."
    "assistant_calendar_required"->"Ative a publicação automática no Calendário e confirme novamente. Nenhuma arte foi criada."
    "assistant_instagram_required"->"Conecte seu Instagram pelo botão acima e confirme novamente. Nenhuma arte foi criada."
    "assistant_balance_required"->"Seu saldo não permite essa quantidade. Escolha menos itens ou veja os combos."
    "assistant_conversation_limit"->"Você chegou ao limite de conversa. Seu planejamento continua salvo."
    "assistant_attempt_preserved"->"Essa resposta não foi confirmada. A tentativa foi preservada para evitar cobrança repetida."
    "assistant_schedule_invalid","assistant_draft_changed"->"Confira os dias e horários antes de confirmar."
    "assistant_photo_invalid"->"Não consegui preparar essa foto. Escolha uma imagem JPG, PNG ou WebP."
    "assistant_photo_limit"->"Envie até quatro fotos por mensagem."
    "assistant_busy","assistant_rate_limit"->"Aguarde um instante antes de enviar outra mensagem."
    else->"A conexão não confirmou esta ação. Seus dados foram preservados; tente confirmar novamente."
}

internal class AssistantViewModelFactory(private val context:Context,private val token:()->String):ViewModelProvider.Factory{
    override fun <T:ViewModel>create(modelClass:Class<T>):T{@Suppress("UNCHECKED_CAST")return AssistantViewModel(context.applicationContext,token) as T}
}
