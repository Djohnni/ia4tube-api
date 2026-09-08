package br.com.ia4tube.app.feature.instagram

import java.nio.ByteBuffer
import java.security.MessageDigest

/** Local content binding, never a server identity or permission to publish. No plaintext is stored. */
internal fun instagramUploadFingerprint(jpeg: ByteArray, caption: String): String {
    val text = caption.toByteArray(Charsets.UTF_8)
    return try {
        MessageDigest.getInstance("SHA-256")
            .digestWith(jpeg, text)
            .joinToString("") { "%02x".format(it.toInt() and 0xff) }
    } finally { text.fill(0) }
}

private fun MessageDigest.digestWith(jpeg: ByteArray, caption: ByteArray): ByteArray {
    update("ia4tube-upload-content-v1".toByteArray(Charsets.US_ASCII))
    update(ByteBuffer.allocate(4).putInt(jpeg.size).array())
    update(jpeg)
    update(ByteBuffer.allocate(4).putInt(caption.size).array())
    return digest(caption)
}

internal fun instagramUploadPhaseLabel(witness: InstagramUploadWitness): String = when (witness.phase) {
    InstagramUploadPhase.PREPARED -> "Preparando o registro do envio. Nenhum resultado foi confirmado."
    InstagramUploadPhase.IN_FLIGHT -> "Enviando a imagem para revisão. Aguarde; não é uma publicação no Instagram."
    InstagramUploadPhase.CONFIRMED -> "Imagem enviada para revisão. A publicação ainda depende de confirmação explícita."
    InstagramUploadPhase.REJECTED -> "O envio anterior não foi aceito. Confira o motivo antes de tentar novamente."
    InstagramUploadPhase.UNKNOWN -> "Não foi possível confirmar o resultado do envio. Consulte o estado; um novo envio permanece bloqueado."
}
