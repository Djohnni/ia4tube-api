package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.models.CompanyGraphicMaterialProfileRequest
import br.com.ia4tube.app.data.repository.CompanyGraphicMaterialsRepository

class GenerateCompanyGraphicMaterialUseCase(
    private val repository: CompanyGraphicMaterialsRepository
) {
    suspend operator fun invoke(
        materialId: String,
        request: CompanyGraphicMaterialProfileRequest
    ) = repository.request(materialId, request)
}
