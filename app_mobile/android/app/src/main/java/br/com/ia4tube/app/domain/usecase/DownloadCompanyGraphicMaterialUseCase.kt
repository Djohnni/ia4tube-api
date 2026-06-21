package br.com.ia4tube.app.domain.usecase

import br.com.ia4tube.app.core.download.ImageDownloadStore
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.CompanyGraphicMaterial
import br.com.ia4tube.app.data.models.GeneratedCompanyGraphicMaterial
import br.com.ia4tube.app.data.repository.CompanyGraphicMaterialsRepository

class DownloadCompanyGraphicMaterialUseCase(
    private val repository: CompanyGraphicMaterialsRepository,
    private val imageDownloadStore: ImageDownloadStore
) {
    suspend operator fun invoke(material: CompanyGraphicMaterial): ApiResult<GeneratedCompanyGraphicMaterial> {
        return when (val image = repository.download(material.id)) {
            is ApiResult.Failure -> image
            is ApiResult.Success -> {
                when (val saved = imageDownloadStore.saveGraphicMaterialImage(material.id, image.value)) {
                    is ApiResult.Failure -> saved
                    is ApiResult.Success -> ApiResult.Success(
                        GeneratedCompanyGraphicMaterial(
                            materialId = material.id,
                            title = material.title,
                            savedPath = saved.value,
                            image = image.value
                        )
                    )
                }
            }
        }
    }
}
