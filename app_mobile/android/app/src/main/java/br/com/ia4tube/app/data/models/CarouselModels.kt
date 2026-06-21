package br.com.ia4tube.app.data.models

data class CarouselRequest(
    val tema: String,
    val briefing: String,
    val quantidadeTelas: Int,
    val nivelConteudo: Int = 2,
    val logo: UploadFile? = null,
    val fotos: List<UploadFile> = emptyList()
)

data class CarouselRequestResponse(
    val carrosselId: String,
    val ciclo: String,
    val status: String,
    val statusLabel: String
)

data class CarouselStatus(
    val id: String,
    val carrosselId: String,
    val tema: String,
    val quantidadeTelas: Int,
    val nivelConteudo: Int = 2,
    val status: String,
    val statusLabel: String,
    val ready: Boolean,
    val ciclo: String,
    val criadoEm: String,
    val atualizadoEm: String,
    val descricaoInstagram: String,
    val downloadUrl: String
)

data class CarouselStatusResponse(
    val carousel: CarouselStatus
)

data class CarouselListResponse(
    val carousels: List<CarouselStatus>
)

data class DownloadedFile(
    val bytes: ByteArray,
    val contentType: String,
    val fileName: String
)

data class CarouselImage(
    val fileName: String,
    val bytes: ByteArray,
    val contentType: String
)

data class CarouselSharePayload(
    val carrosselId: String,
    val images: List<CarouselImage>,
    val descricaoInstagram: String
)

data class DownloadedCarousel(
    val carrosselId: String,
    val savedPath: String,
    val savedPaths: List<String>,
    val imageCount: Int
)
