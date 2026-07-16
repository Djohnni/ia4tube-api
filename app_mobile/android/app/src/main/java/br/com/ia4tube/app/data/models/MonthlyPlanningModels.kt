package br.com.ia4tube.app.data.models

data class MonthlyPlanningRequest(
    val quantidadeReservada: Int,
    val nomeEmpresa: String,
    val ramo: String,
    val caracteristicasEmpresa: List<String> = emptyList(),
    val informacoesEmpresa: String = "",
    val logo: UploadFile? = null,
    val fotos: List<MonthlyPlanningPhotoInput> = emptyList()
)

data class MonthlyPlanningPhotoInput(
    val slotId: String,
    val order: Int,
    val file: UploadFile? = null,
    val objetivo: String = "",
    val objetivoId: String = "",
    val escritaImagem: String = "",
    val nivelEdicao: Int = 2,
    val orientacao: String = ""
)

data class MonthlyPlanningRequestResponse(
    val planningId: String,
    val ciclo: String,
    val createdAt: String = "",
    val status: String,
    val statusLabel: String,
    val quantidadeReservada: Int,
    val artesDesteCiclo: Int,
    val reservadasNoPlanejamento: Int,
    val livresParaCriarArte: Int,
    val cobrancaOrigem: String = "",
    val tipoCompra: String = "",
    val valorCobrado: Double = 0.0,
    val arteGratis: Boolean = false
)

data class MonthlyPlanningSummaryDto(
    val id: String,
    val title: String,
    val status: String,
    val cycle: String,
    val createdAt: String,
    val totalPosts: Int,
    val readyPosts: Int,
    val productionPosts: Int,
    val plannedPosts: Int,
    val errorPosts: Int
)

data class MonthlyPlanningPostDto(
    val number: Int,
    val itemId: String,
    val planningId: String = "",
    val planejamentoItemId: String = "",
    val date: String,
    val time: String,
    val theme: String,
    val objective: String,
    val status: String,
    val statusLabel: String,
    val caption: String,
    val pedidoId: String,
    val imageReady: Boolean,
    val imageText: String = "",
    val thumbnailUrl: String = ""
)

data class MonthlyPlanningRescheduleRequest(
    val itemKey: String,
    val planningId: String = "",
    val planejamentoItemId: String = "",
    val pedidoId: String = "",
    val date: String,
    val time: String = ""
)

data class MonthlyPlanningDetailDto(
    val summary: MonthlyPlanningSummaryDto,
    val posts: List<MonthlyPlanningPostDto>
)
