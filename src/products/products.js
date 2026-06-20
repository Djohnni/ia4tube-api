const PRODUCTS = {
  resultado: {
    id: "resultado",
    name: "Resultado do jogo",
    price: 8.00,
    category: "time",
    flyerTipos: [],
    aliases: ["resultado", "resultado_jogo", "resultado_do_jogo"]
  },

  escalacao: {
    id: "escalacao",
    name: "Escalação",
    price: 8.00,
    category: "time",
    flyerTipos: ["zz1fs"],
    aliases: ["escalacao"]
  },

  contratacao: {
    id: "contratacao",
    name: "Contratação",
    price: 7.00,
    category: "time",
    flyerTipos: ["zz1fm"],
    aliases: ["contratacao"]
  },

  proximo_jogo: {
    id: "proximo_jogo",
    name: "Próximo jogo",
    price: 7.00,
    category: "time",
    flyerTipos: ["zz1ft"],
    aliases: ["proximo_jogo"]
  },

  treino: {
    id: "treino",
    name: "Dia de Treino",
    price: 7.00,
    category: "time",
    flyerTipos: ["treino"],
    aliases: ["treino", "dia_de_treino"]
  },

  patrocinador: {
    id: "patrocinador",
    name: "Patrocinador / Apoio",
    price: 8.00,
    category: "time",
    flyerTipos: ["zz1fj"],
    aliases: ["patrocinador"]
  },

  escudo3d: {
    id: "escudo3d",
    name: "Escudo 3D",
    price: 4.00,
    category: "time",
    flyerTipos: ["escudo3d"],
    aliases: ["escudo3d"]
  },

  proximo_jogo_jogador: {
    id: "proximo_jogo_jogador",
    name: "Próximo jogo jogador",
    price: 7.00,
    category: "jogador",
    flyerTipos: ["jog_proximo"],
    aliases: ["proximo_jogo_jogador"]
  },

  resultado_jogo_jogador: {
    id: "resultado_jogo_jogador",
    name: "Resultado jogador",
    price: 8.00,
    category: "jogador",
    flyerTipos: ["jog_resultado"],
    aliases: ["resultado_jogo_jogador"]
  },

  jogador_escudo: {
    id: "jogador_escudo",
    name: "Jogador + escudo",
    price: 6.00,
    category: "jogador",
    flyerTipos: ["jog_escudo"],
    aliases: ["jogador_escudo"]
  },

  mascote_uniforme: {
    id: "mascote_uniforme",
    name: "Mascote + uniforme",
    price: 18.00,
    category: "time",
    flyerTipos: ["mascote_uniforme"],
    aliases: ["mascote_uniforme"]
  },

  arte_empresa: {
    id: "arte_empresa",
    name: "Arte para empresa",
    price: 1.99,
    category: "empresa",
    flyerTipos: ["arte_empresa"],
    aliases: [
      "arte_empresa",
      "arte_para_empresa",
      "ia4tube_empresas",
      "empresa",
      "negocio",
      "arte_negocio",
      "arte_comercial",
      "post_empresa",
      "post_comercial"
    ]
  }
};

module.exports = PRODUCTS;
