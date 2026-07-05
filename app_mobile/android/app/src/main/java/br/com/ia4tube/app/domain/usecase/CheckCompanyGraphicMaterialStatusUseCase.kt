package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.CompanyGraphicMaterialsRepository

class CheckCompanyGraphicMaterialStatusUseCase(
    private val repository: CompanyGraphicMaterialsRepository
) {
    suspend operator fun invoke(materialId: String, ramo: String) = repository.status(materialId, ramo)
}
