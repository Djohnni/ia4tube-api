package br.com.ia4tube.app.data.models

data class CompanyGraphicMaterial(
    val id: String,
    val title: String,
    val type: String,
    val scope: String,
    val format: String,
    val width: Int,
    val height: Int,
    val status: String,
    val statusLabel: String,
    val createdInCycle: Boolean,
    val createdAt: String,
    val documentId: String,
    val ready: Boolean,
    val downloadUrl: String,
    val locked: Boolean,
    val planRequired: String
)

data class CompanyGraphicMaterialsPlan(
    val key: String,
    val nome: String,
    val status: String
)

data class CompanyGraphicMaterialsLimits(
    val geral: Int,
    val ramo: Int
)

data class CompanyGraphicMaterialsListResponse(
    val ciclo: String,
    val plano: CompanyGraphicMaterialsPlan,
    val limites: CompanyGraphicMaterialsLimits,
    val materiais: List<CompanyGraphicMaterial>
)

data class CompanyGraphicMaterialProfileRequest(
    val nomeEmpresa: String,
    val ramo: String,
    val whatsapp: String,
    val instagram: String,
    val historia: String,
    val endereco: String,
    val cidade: String,
    val estado: String,
    val cep: String,
    val email: String,
    val site: String,
    val logo: UploadFile?
)

data class CompanyGraphicMaterialRequestResponse(
    val documentId: String,
    val materialId: String,
    val title: String,
    val scope: String,
    val ciclo: String,
    val status: String,
    val statusLabel: String
)

data class CompanyGraphicMaterialStatusResponse(
    val material: CompanyGraphicMaterial,
    val ciclo: String
)

data class GeneratedCompanyGraphicMaterial(
    val materialId: String,
    val title: String,
    val savedPath: String,
    val image: DownloadedImage
)
