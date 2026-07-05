package br.com.ia4tube.app.data.models

data class LoginResponse(
    val token: String,
    val nomeTime: String,
    val saldo: Double
)

data class AppVersionInfo(
    val latestVersionCode: Int,
    val minimumVersionCode: Int,
    val latestVersionName: String,
    val updateRequired: Boolean,
    val title: String,
    val message: String,
    val playStoreUrl: String
)

data class MeResponse(
    val nomeTime: String,
    val saldo: Double,
    val ativo: Boolean,
    val planoAtual: String = "",
    val planoStatus: String = "none",
    val planoNome: String = "",
    val planoRenovaEm: String = "",
    val artesMensaisTotal: Int = 0,
    val artesMensaisUsadas: Int = 0,
    val artesMensaisRestantes: Int = 0,
    val artesAvulsasRestantes: Int = 0,
    val artesAvulsasUsadas: Int = 0,
    val artesAvulsasTotalCompradas: Int = 0,
    val arteAvulsaValor: Double = 5.99,
    val arteAvulsaProdutoId: String = "",
    val arteAvulsaTitulo: String = "",
    val saldoExtra: Double = 0.0,
    val carrosseisLimite: Int? = null,
    val carrosseisUsados: Int? = null,
    val carrosseisRestantes: Int? = null,
    val carrosseisCiclo: String? = null
)

data class OrderSummary(
    val id: String,
    val tipo: String,
    val status: String,
    val imagemPronta: Boolean,
    val pagamentoPendente: Boolean,
    val createdAt: String = "",
    val isMonthlyPlanning: Boolean = false,
    val planningId: String = "",
    val title: String = "",
    val totalPosts: Int = 0,
    val readyPosts: Int = 0,
    val productionPosts: Int = 0,
    val plannedPosts: Int = 0,
    val errorPosts: Int = 0
)

data class OrderInfo(
    val id: String,
    val status: String,
    val previewUrl: String,
    val imagemPronta: Boolean,
    val aprovadoCliente: Boolean,
    val pagamentoPendente: Boolean,
    val valorPendente: Double,
    val motivoPagamentoPendente: String,
    val descricaoInstagram: String,
    val categoria: String = "",
    val nomeEmpresa: String = "",
    val ramo: String = "",
    val objetivo: String = "",
    val tipoArte: String = "",
    val fraseFoto: String = "",
    val cta: String = "",
    val whatsappContato: String = "",
    val instagram: String = "",
    val historiaEmpresa: String = "",
    val podeBaixar: Boolean,
    val podePedirAjuste: Boolean,
    val downloadBloqueado: Boolean = false,
    val mensagemDownloadBloqueado: String = ""
)
