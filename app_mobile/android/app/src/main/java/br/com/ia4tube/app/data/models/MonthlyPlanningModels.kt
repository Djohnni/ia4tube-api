package br.com.ia4tube.app.data.models

data class MonthlyPlanningRequest(
    val quantidadeReservada: Int,
    val nomeEmpresa: String,
    val ramo: String,
    val fotos: List<MonthlyPlanningPhotoInput> = emptyList()
)

data class MonthlyPlanningPhotoInput(
    val file: UploadFile,
    val orientacao: String = ""
)

data class MonthlyPlanningRequestResponse(
    val planningId: String,
    val ciclo: String,
    val status: String,
    val statusLabel: String,
    val quantidadeReservada: Int,
    val artesDesteCiclo: Int,
    val reservadasNoPlanejamento: Int,
    val livresParaCriarArte: Int
)

data class MonthlyPlanningSummaryDto(
    val id: String,
    val title: String,
    val status: String,
    val cycle: String,
    val totalPosts: Int,
    val readyPosts: Int,
    val productionPosts: Int,
    val plannedPosts: Int,
    val errorPosts: Int
)

data class MonthlyPlanningPostDto(
    val number: Int,
    val itemId: String,
    val date: String,
    val time: String,
    val theme: String,
    val objective: String,
    val status: String,
    val statusLabel: String,
    val caption: String,
    val pedidoId: String,
    val imageReady: Boolean
)

data class MonthlyPlanningDetailDto(
    val summary: MonthlyPlanningSummaryDto,
    val posts: List<MonthlyPlanningPostDto>
)
