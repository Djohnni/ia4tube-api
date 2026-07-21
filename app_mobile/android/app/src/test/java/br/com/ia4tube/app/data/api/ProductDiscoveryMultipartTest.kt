package br.com.ia4tube.app.data.api

import br.com.ia4tube.app.data.models.UploadFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ProductDiscoveryMultipartTest {
    private val image = UploadFile(
        fileName = "prateleira.jpg",
        contentType = "image/jpeg",
        bytes = byteArrayOf(1, 2, 3)
    )

    @Test
    fun absentBusinessContextKeepsTheLegacyMultipartContract() {
        val multipart = buildProductDiscoveryMultipart(image, null)
        val dispositions = multipart.parts.mapNotNull {
            it.headers?.get("Content-Disposition")
        }

        assertEquals(1, multipart.parts.size)
        assertTrue(dispositions.any { it.contains("name=\"imagem\"") })
        assertFalse(dispositions.any { it.contains("name=\"ramo_contexto\"") })
    }

    @Test
    fun explicitEmptyBusinessContextIsSentAsAnEmptyMultipartField() {
        val multipart = buildProductDiscoveryMultipart(image, "")
        val contextPart = multipart.parts.single {
            it.headers?.get("Content-Disposition")?.contains("name=\"ramo_contexto\"") == true
        }

        assertEquals(2, multipart.parts.size)
        assertEquals(0L, contextPart.body.contentLength())
    }

    @Test
    fun specificBusinessContextIsSentWithoutChangingTheImagePart() {
        val multipart = buildProductDiscoveryMultipart(image, "Padaria")
        val dispositions = multipart.parts.mapNotNull {
            it.headers?.get("Content-Disposition")
        }

        assertEquals(2, multipart.parts.size)
        assertTrue(dispositions.any { it.contains("name=\"imagem\"") })
        assertTrue(dispositions.any { it.contains("name=\"ramo_contexto\"") })
    }
}
