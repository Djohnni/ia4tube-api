package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.data.repository.CompanyGraphicMaterialsRepository

class ListCompanyGraphicMaterialsUseCase(
    private val repository: CompanyGraphicMaterialsRepository
) {
    suspend operator fun invoke(ramo: String) = repository.list(ramo)
}
