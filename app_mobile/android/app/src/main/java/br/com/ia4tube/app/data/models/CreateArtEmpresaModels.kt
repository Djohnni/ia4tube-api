package br.com.ia4tube.app.data.models

data class UploadFile(
    val fileName: String,
    val contentType: String,
    val bytes: ByteArray,
    val optimized: Boolean = false,
    val originalSizeBytes: Int = bytes.size,
    val originalWidth: Int = 0,
    val originalHeight: Int = 0
)

data class CreateArtEmpresaRequest(
    val nomeEmpresa: String,
    val ramo: String,
    val objetivo: String,
    val estiloVisualCliente: String,
    val rodada: String,
    val data: String,
    val oferta: String,
    val cta: String,
    val whatsapp: String,
    val instagram: String,
    val observacoes: String,
    val fraseFoto: String = "",
    val historiaEmpresa: String = "",
    val origemFotoRapida: Boolean = false,
    val camposDinamicos: Map<String, String> = emptyMap(),
    val logo: UploadFile,
    val fotos: List<UploadFile> = emptyList(),
    val referencias: List<UploadFile> = emptyList(),
    val modeloExistente: UploadFile? = null
)

data class FootballOrderRequest(
    val productKey: String,
    val endpoint: String,
    val flyerTipo: String = "",
    val nomeEmpresa: String = "",
    val ramo: String = "",
    val objetivo: String = "",
    val fields: Map<String, String> = emptyMap(),
    val nestedFields: Map<String, Any> = emptyMap(),
    val files: Map<String, UploadFile> = emptyMap(),
    val multiFiles: Map<String, List<UploadFile>> = emptyMap()
)

data class CreateOrderResponse(
    val pedidoId: String
)
