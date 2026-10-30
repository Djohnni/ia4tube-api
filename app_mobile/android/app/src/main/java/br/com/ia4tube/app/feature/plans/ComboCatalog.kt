package br.com.ia4tube.app.feature.plans

/** Immutable purchase IDs: old paid plans and outstanding Pix keep their original definitions. */
internal data class ComboOffer(val id: String, val title: String, val priceReais: Int, val images: Int, val videos: Int) {
    val allowance: String get() = if (videos == 0) "$images imagens" else "$images imagens · $videos vídeos"
}

internal val mediaCombos = listOf(
    ComboOffer("i4_imagens_10_v1", "Imagens", 69, 10, 0),
    ComboOffer("i4_combo_10i_4v_v1", "Essencial", 99, 10, 4),
    ComboOffer("i4_combo_15i_6v_v1", "Destaque", 139, 15, 6),
    ComboOffer("i4_combo_20i_10v_v1", "Profissional", 199, 20, 10),
    ComboOffer("i4_combo_20i_15v_v1", "Empresarial", 259, 20, 15)
)
