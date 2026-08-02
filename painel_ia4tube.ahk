#Requires AutoHotkey v2.0
#SingleInstance Force
#NoTrayIcon

BASE_DIR := A_ScriptDir
PEDIDOS_DIR := BASE_DIR "\dados\pedidos"
MATERIAIS_GRAFICOS_DIR := BASE_DIR "\dados\materiais_graficos"
CARROSSEIS_DIR := BASE_DIR "\dados\carrosseis"
PLANEJAMENTOS_DIR := BASE_DIR "\dados\planejamentos_mensais"
SUPORTE_DIR := BASE_DIR "\suporte"
g_minimizado := false
g_lastAlerta := ""
g_pipelineSemDesde := 0
g_errosResolvidos := 0
g_suporteResolvidos := 0
g_erroMap := Map()
g_suporteAssinatura := ""
g_suporteJanelaAberta := false
g_suporteTotalUltimoValido := 0
g_suporteTemValorValido := false
g_suporteConsultaValida := false
g_suporteUltimoErro := ""
g_cacheVisual := Map()
g_metricasVisuais := Map(
    "ciclos", 0,
    "textoAplicado", 0,
    "corAplicada", 0,
    "fonteAplicada", 0,
    "textoEvitado", 0,
    "corEvitada", 0,
    "fonteEvitada", 0,
    "invalidacoes", 0
)
WM_METRICAS_VISUAIS := DllCall("RegisterWindowMessage", "Str", "IA4Tube.Painel.MetricasVisuais.Etapa3A", "UInt")
ERROS_RESOLVIDOS_FILE := BASE_DIR "\painel_erros_resolvidos.txt"
SUPORTE_RESOLVIDOS_FILE := BASE_DIR "\painel_suporte_resolvidos.txt"
API_BASE := "https://ia4tube-api.onrender.com"
BOT_TOKEN_FILE := BASE_DIR "\bot_token.txt"

if FileExist(ERROS_RESOLVIDOS_FILE) {
    try g_errosResolvidos := Integer(Trim(FileRead(ERROS_RESOLVIDOS_FILE, "UTF-8")))
}

if FileExist(SUPORTE_RESOLVIDOS_FILE) {
    try g_suporteResolvidos := Integer(Trim(FileRead(SUPORTE_RESOLVIDOS_FILE, "UTF-8")))
}

global GuiPainel, g_minimizado, g_lastAlerta, g_pipelineSemDesde, g_errosResolvidos, g_suporteResolvidos, g_erroMap, g_suporteAssinatura, g_suporteJanelaAberta, g_suporteTotalUltimoValido, g_suporteTemValorValido, g_suporteConsultaValida, g_suporteUltimoErro, g_cacheVisual, g_metricasVisuais, WM_METRICAS_VISUAIS, ERROS_RESOLVIDOS_FILE, SUPORTE_RESOLVIDOS_FILE
global BASE_DIR, PEDIDOS_DIR, MATERIAIS_GRAFICOS_DIR, CARROSSEIS_DIR, PLANEJAMENTOS_DIR, SUPORTE_DIR, API_BASE, BOT_TOKEN_FILE
global g_listaConversasIds := Map()
global g_conversaSelecionadaId := ""
global g_conversaSelecionadaId := ""
global txtTitulo, txtStatus, txtFila, txtAndamento, txtHoje, txtErro, txtUltimo, txtBot, txtProgramas, txtMgTitulo, txtMgPend, txtMgProc, txtMgHoje, txtMgErro, txtMgUltimo, txtProgramasMg, txtCarTitulo, txtCarPend, txtCarProc, txtCarHoje, txtCarErro, txtCarUltimo, txtProgramasCar, txtPlanTitulo, txtPlanPend, txtPlanProc, txtPlanHoje, txtPlanErro, txtPlanUltimo, txtProgramasPlan, txtProgramasPlanArt, txtPlanVision, txtPlanUltimaAnalise, txtSuporte, txtAlerta, txtErroTitulo, txtErroLinhas

GuiPainel := Gui("+AlwaysOnTop -Caption +ToolWindow +Border")
GuiPainel.BackColor := "202124"
GuiPainel.SetFont("s8 cFFFFFF", "Segoe UI")
OnMessage(WM_METRICAS_VISUAIS, ResponderMetricasVisuais)

GuiPainel.AddText("x0 y0 w220 h24 Background303134")
btnMais := GuiPainel.AddText("x154 y4 w16 h18 cCCCCCC BackgroundTrans Center", "+")
btnMais.OnEvent("Click", AbrirDetalhes)
GuiPainel.AddText("x176 y4 w16 h18 cCCCCCC BackgroundTrans Center", "_").OnEvent("Click", MinimizarPainel)
txtTitulo := GuiPainel.AddText("x8 y4 w65 h18 cFFFFFF BackgroundTrans", "IA4Tube")
txtTitulo.OnEvent("Click", MoverPainel)
txtStatus := GuiPainel.AddText("x76 y4 w75 h18 c66FF99 BackgroundTrans", "verificando")
txtStatus.OnEvent("Click", MoverPainel)
GuiPainel.AddText("x198 y4 w16 h18 cCCCCCC BackgroundTrans Center", "x").OnEvent("Click", (*) => FecharTudo())

txtBot := GuiPainel.AddText("x10 y30 w170 h18 cBFC3C7", "Bot: verificando")
txtBot.OnEvent("Click", IniciarBot)
GuiPainel.AddText("x190 y30 w20 h18 cFF6666 Center", "X").OnEvent("Click", FecharBot)

GuiPainel.AddText("x10 y54 w200 h14 c5F6368", "--------------------")
GuiPainel.AddText("x10 y70 w200 h18 cFFD166", "Pedidos:")
txtFila := GuiPainel.AddText("x10 y92 w95 h18 cFFFFFF", "Pend: 0")
txtAndamento := GuiPainel.AddText("x115 y92 w95 h18 cFFFFFF", "Proc: 0")
txtHoje := GuiPainel.AddText("x10 y114 w95 h18 cFFFFFF", "Hoje: 0")
txtErro := GuiPainel.AddText("x115 y114 w95 h18 cFFFFFF", "Erro: 0")
txtErro.OnEvent("Click", MarcarErrosResolvidos)
txtUltimo := GuiPainel.AddText("x10 y136 w200 h18 cBFC3C7", "Ultimo: -")
txtProgramas := GuiPainel.AddText("x10 y158 w200 h18 cBFC3C7", "Run: -  Pipe: -")

GuiPainel.AddText("x10 y184 w200 h14 c5F6368", "--------------------")
txtMgTitulo := GuiPainel.AddText("x10 y200 w200 h18 cFFD166", "Materiais Graficos:")
txtMgPend := GuiPainel.AddText("x10 y222 w95 h18 cFFFFFF", "Pend MG: 0")
txtMgProc := GuiPainel.AddText("x115 y222 w95 h18 cFFFFFF", "Proc MG: 0")
txtMgHoje := GuiPainel.AddText("x10 y244 w95 h18 cFFFFFF", "Hoje MG: 0")
txtMgErro := GuiPainel.AddText("x115 y244 w95 h18 cFFFFFF", "Erro MG: 0")
txtMgUltimo := GuiPainel.AddText("x10 y266 w200 h18 cBFC3C7", "Ultimo MG: -")
txtProgramasMg := GuiPainel.AddText("x10 y288 w200 h18 cBFC3C7", "Run MG: -  Pipe MG: -")

GuiPainel.AddText("x10 y314 w200 h14 c5F6368", "--------------------")
txtCarTitulo := GuiPainel.AddText("x10 y330 w200 h18 cFFD166", "Carrossel:")
txtCarPend := GuiPainel.AddText("x10 y352 w95 h18 cFFFFFF", "Pend Car: 0")
txtCarProc := GuiPainel.AddText("x115 y352 w95 h18 cFFFFFF", "Proc Car: 0")
txtCarHoje := GuiPainel.AddText("x10 y374 w95 h18 cFFFFFF", "Hoje Car: 0")
txtCarErro := GuiPainel.AddText("x115 y374 w95 h18 cFFFFFF", "Erro Car: 0")
txtCarUltimo := GuiPainel.AddText("x10 y396 w200 h18 cBFC3C7", "Ultimo Car: -")
txtProgramasCar := GuiPainel.AddText("x10 y418 w200 h18 cBFC3C7", "Run Car: -  Pipe Car: -")

GuiPainel.AddText("x10 y444 w200 h14 c5F6368", "--------------------")
txtPlanTitulo := GuiPainel.AddText("x10 y460 w200 h18 cFFD166", "Planejamento Mensal:")
txtPlanPend := GuiPainel.AddText("x10 y482 w95 h18 cFFFFFF", "Pend Plan: 0")
txtPlanProc := GuiPainel.AddText("x115 y482 w95 h18 cFFFFFF", "Proc Plan: 0")
txtPlanHoje := GuiPainel.AddText("x10 y504 w95 h18 cFFFFFF", "Hoje Plan: 0")
txtPlanErro := GuiPainel.AddText("x115 y504 w95 h18 cFFFFFF", "Erro Plan: 0")
txtPlanUltimo := GuiPainel.AddText("x10 y526 w200 h18 cBFC3C7", "Ultimo Plan: -")
txtProgramasPlan := GuiPainel.AddText("x10 y548 w200 h18 cBFC3C7", "Run Plan: -  Pipe Plan: -")
txtProgramasPlanArt := GuiPainel.AddText("x10 y570 w200 h18 cBFC3C7", "Run Arte Plan: -")
txtPlanVision := GuiPainel.AddText("x10 y592 w200 h18 cBFC3C7", "Vision: -")
txtPlanUltimaAnalise := GuiPainel.AddText("x10 y614 w200 h18 cBFC3C7", "Ultima analise: -")

txtSuporte := GuiPainel.AddText("x10 y642 w200 h18 c66FF99", "Suporte: 0")
txtSuporte.OnEvent("Click", BaixarUmSuporteEAbrirPainel)
txtAlerta := GuiPainel.AddText("x10 y664 w200 h18 c66FF99", "Alerta: tudo ok")

btnArtesGratis := GuiPainel.AddText("x10 y688 w200 h24 c111827 BackgroundFFD166 Center", "Artes Grátis da Semana")
btnArtesGratis.OnEvent("Click", AbrirArtesGratisSemana)

btnAbrirTudo := GuiPainel.AddText("x10 y720 w96 h24 cFFFFFF Background15803D Center", "ABRIR TUDO")
btnAbrirTudo.OnEvent("Click", (*) => AbrirTudo())
btnPararTudo := GuiPainel.AddText("x114 y720 w96 h24 cFFFFFF Background8B0000 Center", "PARAR TUDO")
btnPararTudo.OnEvent("Click", (*) => FecharTudo())

txtErroTitulo := GuiPainel.AddText("x10 y752 w200 h18 cFFD166", "Erros dos pedidos:")
txtErroLinhas := []
Loop 8 {
    yLinha := 774 + ((A_Index - 1) * 20)
    linha := GuiPainel.AddText("x10 y" yLinha " w200 h18 cFF6666", "")
    linha.OnEvent("Click", AbrirErroPedido.Bind(A_Index))
    txtErroLinhas.Push(linha)
}

GuiPainel.Show("x10 y10 w220 h950 NoActivate")

SetTimer(AtualizarPainel, 5000)
AtualizarPainel()

MoverPainel(*) {
    global GuiPainel
    PostMessage(0xA1, 2,,, GuiPainel.Hwnd)
}

ChaveCacheVisual(gui, controle, propriedade) {
    return ObjPtr(gui) "|" gui.Hwnd "|" ObjPtr(controle) "|" controle.Hwnd "|" propriedade
}

RegistrarResultadoVisual(propriedade, aplicado) {
    global g_metricasVisuais

    chave := propriedade (propriedade = "texto"
        ? (aplicado ? "Aplicado" : "Evitado")
        : (aplicado ? "Aplicada" : "Evitada"))
    g_metricasVisuais[chave] += 1
}

AplicarTextoVisualSeMudou(gui, controle, valor) {
    global g_cacheVisual

    chave := ChaveCacheVisual(gui, controle, "texto")
    if (g_cacheVisual.Has(chave) && g_cacheVisual[chave] == valor) {
        RegistrarResultadoVisual("texto", false)
        return false
    }

    controle.Text := valor
    g_cacheVisual[chave] := valor
    RegistrarResultadoVisual("texto", true)
    return true
}

AplicarCorVisualSeMudou(gui, controle, opcoesCor) {
    global g_cacheVisual

    chave := ChaveCacheVisual(gui, controle, "cor")
    if (g_cacheVisual.Has(chave) && g_cacheVisual[chave] == opcoesCor) {
        RegistrarResultadoVisual("cor", false)
        return false
    }

    controle.SetFont(opcoesCor)
    g_cacheVisual[chave] := opcoesCor
    RegistrarResultadoVisual("cor", true)
    return true
}

AplicarFonteVisualSeMudou(gui, controle, opcoesFonte, nomeFonte := "") {
    global g_cacheVisual

    valor := opcoesFonte "|" nomeFonte
    chave := ChaveCacheVisual(gui, controle, "fonte")
    if (g_cacheVisual.Has(chave) && g_cacheVisual[chave] == valor) {
        RegistrarResultadoVisual("fonte", false)
        return false
    }

    if (nomeFonte = "")
        controle.SetFont(opcoesFonte)
    else
        controle.SetFont(opcoesFonte, nomeFonte)

    g_cacheVisual[chave] := valor
    RegistrarResultadoVisual("fonte", true)
    return true
}

InvalidarCacheVisual(gui) {
    global g_cacheVisual, g_metricasVisuais

    prefixo := ObjPtr(gui) "|"
    chaves := []
    for chave, estado in g_cacheVisual {
        if (SubStr(chave, 1, StrLen(prefixo)) = prefixo)
            chaves.Push(chave)
    }

    for chave in chaves
        g_cacheVisual.Delete(chave)

    g_metricasVisuais["invalidacoes"] += 1
}

RegistrarCicloVisual() {
    global g_metricasVisuais
    g_metricasVisuais["ciclos"] += 1
}

ResponderMetricasVisuais(wParam, lParam, msg, hwnd) {
    global GuiPainel, g_metricasVisuais

    if (hwnd != GuiPainel.Hwnd)
        return 0

    chaves := [
        "ciclos",
        "textoAplicado",
        "corAplicada",
        "fonteAplicada",
        "textoEvitado",
        "corEvitada",
        "fonteEvitada",
        "invalidacoes"
    ]

    if (wParam < 1 || wParam > chaves.Length)
        return 0

    return g_metricasVisuais[chaves[wParam]]
}

AtualizarPainel() {
    global PEDIDOS_DIR, SUPORTE_DIR, GuiPainel, g_minimizado, g_lastAlerta, g_pipelineSemDesde, g_errosResolvidos, g_suporteResolvidos, g_suporteConsultaValida, g_suporteTemValorValido, g_suporteUltimoErro, g_erroMap, txtTitulo, txtStatus, txtFila, txtAndamento, txtHoje, txtErro, txtUltimo, txtBot, txtProgramas, txtMgPend, txtMgProc, txtMgHoje, txtMgErro, txtMgUltimo, txtProgramasMg, txtCarPend, txtCarProc, txtCarHoje, txtCarErro, txtCarUltimo, txtProgramasCar, txtPlanPend, txtPlanProc, txtPlanHoje, txtPlanErro, txtPlanUltimo, txtProgramasPlan, txtProgramasPlanArt, txtPlanVision, txtPlanUltimaAnalise, txtSuporte, txtAlerta, txtErroTitulo, txtErroLinhas

    RegistrarCicloVisual()

    pendentes := 0
    andamento := 0
    feitosHoje := 0
    erros := 0
    ultimo := ""

    hoje := FormatTime(, "yyyyMMdd")

    if DirExist(PEDIDOS_DIR) {
        Loop Files PEDIDOS_DIR "\pedido.json", "FR" {
            pasta := A_LoopFileDir
            if (InStr(StrLower(pasta), "\_downloads\"))
                continue

            nome := NomePedidoDaPasta(pasta)

            if (ultimo = "" || StrCompare(nome, ultimo) > 0)
                ultimo := nome

            temPedido := true
            temResultado := FileExist(pasta "\resultado_final.png")
            temOk := FileExist(pasta "\processado_handoff.txt")
            temLock := FileExist(pasta "\processando.lock")
            temErro := FileExist(pasta "\erro_runner.txt") || FileExist(pasta "\erro_validacao.txt")
            statusPedido := LerStatusPedido(pasta)

            if (
                temLock
                && !temOk
                && !temErro
                && temPedido
                && !temResultado
            )
                andamento++

            if (temErro && !temOk && SubStr(nome, 1, 8) = hoje)
                erros++

            if (SubStr(nome, 1, 8) = hoje && (temOk || temResultado || statusPedido = "pronto"))
                feitosHoje++

            if (temPedido && !temResultado && !temOk && !temErro && !temLock && statusPedido != "pronto")
                pendentes++
        }
    }

    errosLista := ColetarErrosPedidos()
    erros := errosLista.Length
    RenderizarErrosPainel(errosLista)

    statsMg := ColetarStatsMateriaisGraficos()
    statsCar := ColetarStatsCarrosseis()
    statsPlan := ColetarStatsPlanejamentoMensal()
    statusProc := GetProgramStatus()
    runnerAtivo := statusProc.runner
    botAtivo := statusProc.bot

    AplicarTextoVisualSeMudou(GuiPainel, txtBot, "Bot: " (statusProc.bot ? "aberto" : "fechado"))
    AplicarCorVisualSeMudou(GuiPainel, txtBot, statusProc.bot ? "c66FF99" : "cFF6666")

    AplicarTextoVisualSeMudou(GuiPainel, txtProgramas, "Run: " (statusProc.runner ? "ON" : "OFF") "  Pipe: " (statusProc.pipeline ? "ON" : "OFF"))
    AplicarTextoVisualSeMudou(GuiPainel, txtProgramasMg, "Run MG: " (statusProc.runnerMg ? "ON" : "OFF") "  Pipe MG: " (statusProc.pipelineMg ? "ON" : "OFF"))
    AplicarCorVisualSeMudou(GuiPainel, txtProgramasMg, (statusProc.runnerMg && statusProc.pipelineMg) ? "c66FF99" : "cFFD166")
    AplicarTextoVisualSeMudou(GuiPainel, txtProgramasCar, "Run Car: " (statusProc.runnerCar ? "ON" : "OFF") "  Pipe Car: " (statusProc.pipelineCar ? "ON" : "OFF"))
    AplicarCorVisualSeMudou(GuiPainel, txtProgramasCar, statusProc.runnerCar ? (statusProc.pipelineCar ? "c66FF99" : "cFFD166") : "cFF6666")
    AplicarTextoVisualSeMudou(GuiPainel, txtProgramasPlan, "Run Plan: " (statusProc.runnerPlan ? "ON" : "OFF") "  Pipe Plan: " (statusProc.pipelinePlan ? "ON" : "OFF"))
    AplicarCorVisualSeMudou(GuiPainel, txtProgramasPlan, statusProc.runnerPlan ? (statusProc.pipelinePlan ? "c66FF99" : "cFFD166") : "cFF6666")
    AplicarTextoVisualSeMudou(GuiPainel, txtProgramasPlanArt, "Run Arte Plan: " (statusProc.runnerPlanArt ? "ON" : "OFF"))
    AplicarCorVisualSeMudou(GuiPainel, txtProgramasPlanArt, statusProc.runnerPlanArt ? "c66FF99" : "cFF6666")
    visionAtiva := VisionPlanejamentoAtiva()
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanVision, "Vision: " (visionAtiva ? "ON" : "OFF"))
    AplicarCorVisualSeMudou(GuiPainel, txtPlanVision, visionAtiva ? "c66FF99" : "cFF6666")

    errosPendentes := erros

    suporteTotal := ContarArquivosSuporte()

    if (g_suporteConsultaValida && g_suporteResolvidos > suporteTotal) {
        g_suporteResolvidos := suporteTotal
        try FileDelete(SUPORTE_RESOLVIDOS_FILE)
        FileAppend(g_suporteResolvidos, SUPORTE_RESOLVIDOS_FILE, "UTF-8")
    }

    suportePendentes := suporteTotal - g_suporteResolvidos
    if (suportePendentes < 0)
        suportePendentes := 0

    if (g_suporteConsultaValida) {
        AplicarTextoVisualSeMudou(GuiPainel, txtSuporte, "Suporte: " suportePendentes)
        AplicarCorVisualSeMudou(GuiPainel, txtSuporte, suportePendentes > 0 ? "cFF3333" : "c66FF99")
    } else {
        valorSuporte := g_suporteTemValorValido ? suportePendentes : "?"
        AplicarTextoVisualSeMudou(GuiPainel, txtSuporte, "Suporte: " valorSuporte " [" g_suporteUltimoErro "]")
        AplicarCorVisualSeMudou(GuiPainel, txtSuporte, "cFFD166")
    }

    if (andamento > 0 && !statusProc.pipeline) {
        if (g_pipelineSemDesde = 0)
            g_pipelineSemDesde := A_TickCount
    } else {
        g_pipelineSemDesde := 0
    }

    pipelineTravado := (g_pipelineSemDesde > 0 && (A_TickCount - g_pipelineSemDesde) >= 120000)

    alerta := ""

    if (suportePendentes > 0) {
        alerta := "SUPORTE CLIENTE (" suportePendentes ")"

        if (g_lastAlerta != alerta) {
            SoundBeep(1400, 220)
            SoundBeep(1700, 220)
        }
    }
    else if (!statusProc.bot)
        alerta := "BOT FECHADO"
    else if (!statusProc.runner && (pendentes > 0 || andamento > 0))
        alerta := "RUNNER PARADO COM FILA"
    else if (pipelineTravado && andamento > 0 && (pendentes > 0 || statusProc.pipeline))
    	alerta := "PIPELINE PARADO 2MIN"
    else if (errosPendentes > 0)
        alerta := "ERRO EM PEDIDO"

    if (alerta != "") {
        AplicarTextoVisualSeMudou(GuiPainel, txtAlerta, "Alerta: " alerta)
        AplicarCorVisualSeMudou(GuiPainel, txtAlerta, "cFF6666")

        if (alerta != g_lastAlerta) {
            SoundBeep(900, 180)
            g_lastAlerta := alerta
        }
    } else {
        AplicarTextoVisualSeMudou(GuiPainel, txtAlerta, "Alerta: tudo ok")
        AplicarCorVisualSeMudou(GuiPainel, txtAlerta, "c66FF99")
        g_lastAlerta := ""
    }

    if (g_minimizado) {
        AplicarTextoVisualSeMudou(GuiPainel, txtTitulo, (alerta != ""
            ? "IA4Tube " (statusProc.bot ? "on " : "off ") pendentes " - " feitosHoje
            : "IA4Tube " (statusProc.bot ? "on " : "off ") pendentes " - " feitosHoje))

        AplicarCorVisualSeMudou(GuiPainel, txtTitulo, alerta != "" ? "cFF6666" : (statusProc.bot ? "c66FF99" : "cFF6666"))

        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "")

        return
    } else {
        AplicarTextoVisualSeMudou(GuiPainel, txtTitulo, "IA4Tube")
        AplicarCorVisualSeMudou(GuiPainel, txtTitulo, "cFFFFFF")
    }

    if (statusProc.bot && statusProc.runner) {
        AplicarCorVisualSeMudou(GuiPainel, txtProgramas, "c66FF99")
    } else {
        AplicarCorVisualSeMudou(GuiPainel, txtProgramas, "cFFD166")
    }

    if (!runnerAtivo) {
        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "runner parado")
        AplicarCorVisualSeMudou(GuiPainel, txtStatus, "cFF6666")
    } else if (errosPendentes > 0) {
        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "erro")
        AplicarCorVisualSeMudou(GuiPainel, txtStatus, "cFF6666")
    } else if (andamento > 0) {
        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "processando")
        AplicarCorVisualSeMudou(GuiPainel, txtStatus, "cFFD166")
    } else {
        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "normal")
        AplicarCorVisualSeMudou(GuiPainel, txtStatus, "c66FF99")
    }

    AplicarTextoVisualSeMudou(GuiPainel, txtFila, "Pend: " pendentes)
    AplicarTextoVisualSeMudou(GuiPainel, txtAndamento, "Proc: " andamento "/10")
    AplicarTextoVisualSeMudou(GuiPainel, txtHoje, "Hoje: " feitosHoje)
    AplicarTextoVisualSeMudou(GuiPainel, txtErro, "Erro: " errosPendentes)
    AplicarTextoVisualSeMudou(GuiPainel, txtMgPend, "Pend MG: " statsMg.pendentes)
    AplicarTextoVisualSeMudou(GuiPainel, txtMgProc, "Proc MG: " statsMg.processando)
    AplicarTextoVisualSeMudou(GuiPainel, txtMgHoje, "Hoje MG: " statsMg.hoje)
    AplicarTextoVisualSeMudou(GuiPainel, txtMgErro, "Erro MG: " statsMg.erros)
    AplicarTextoVisualSeMudou(GuiPainel, txtMgUltimo, "Ultimo MG: " (statsMg.ultimo != "" ? statsMg.ultimo : "-"))
    AplicarCorVisualSeMudou(GuiPainel, txtMgErro, statsMg.erros > 0 ? "cFF6666" : "cFFFFFF")
    AplicarTextoVisualSeMudou(GuiPainel, txtCarPend, "Pend Car: " statsCar.pendentes)
    AplicarTextoVisualSeMudou(GuiPainel, txtCarProc, "Proc Car: " statsCar.processando)
    AplicarTextoVisualSeMudou(GuiPainel, txtCarHoje, "Hoje Car: " statsCar.hoje)
    AplicarTextoVisualSeMudou(GuiPainel, txtCarErro, "Erro Car: " statsCar.erros)
    AplicarTextoVisualSeMudou(GuiPainel, txtCarUltimo, "Ultimo Car: " (statsCar.ultimo != "" ? statsCar.ultimo : "-"))
    AplicarCorVisualSeMudou(GuiPainel, txtCarErro, statsCar.erros > 0 ? "cFF6666" : "cFFFFFF")
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanPend, "Pend Plan: " statsPlan.pendentes)
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanProc, "Proc Plan: " statsPlan.processando)
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanHoje, "Hoje Plan: " statsPlan.hoje)
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanErro, "Erro Plan: " statsPlan.erros)
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanUltimo, "Ultimo Plan: " (statsPlan.ultimo != "" ? statsPlan.ultimo : "-"))
    AplicarTextoVisualSeMudou(GuiPainel, txtPlanUltimaAnalise, "Ultima analise: " (statsPlan.ultimaAnalise != "" ? statsPlan.ultimaAnalise : "-"))
    AplicarCorVisualSeMudou(GuiPainel, txtPlanErro, statsPlan.erros > 0 ? "cFF6666" : "cFFFFFF")
    AplicarTextoVisualSeMudou(GuiPainel, txtUltimo, "Ultimo: " (ultimo != "" ? ultimo : "-"))
}

ColetarErrosPedidos() {
    global PEDIDOS_DIR

    lista := []

    if !DirExist(PEDIDOS_DIR)
        return lista

    Loop Files PEDIDOS_DIR "\pedido.json", "FR" {
        pasta := A_LoopFileDir
        nomePedido := NomePedidoDaPasta(pasta)
        erroArquivo := ""

        if FileExist(pasta "\erro_runner.txt")
            erroArquivo := pasta "\erro_runner.txt"
        else if FileExist(pasta "\erro_validacao.txt")
            erroArquivo := pasta "\erro_validacao.txt"
        else
            continue

        if FileExist(pasta "\processado_handoff.txt")
            continue

        if FileExist(pasta "\painel_erro_visto.txt")
            continue

        textoErro := ""
        try textoErro := Trim(FileRead(erroArquivo, "UTF-8"))

        if (textoErro = "")
            textoErro := A_LoopFileName

        primeiraLinha := StrSplit(textoErro, "`n")[1]
        primeiraLinha := StrReplace(primeiraLinha, "`r", "")
        primeiraLinha := Trim(primeiraLinha)

        if (StrLen(primeiraLinha) > 58)
            primeiraLinha := SubStr(primeiraLinha, 1, 58) "..."

        lista.Push({
            pasta: pasta,
            pedido: nomePedido,
            arquivo: A_LoopFileName,
            erro: primeiraLinha
        })
    }

    return lista
}

RenderizarErrosPainel(lista) {
    global GuiPainel, g_erroMap, txtErroTitulo, txtErroLinhas

    g_erroMap := Map()

    total := lista.Length
    AplicarTextoVisualSeMudou(GuiPainel, txtErroTitulo, total > 0 ? "Erros dos pedidos: " total : "Erros dos pedidos: nenhum")
    AplicarCorVisualSeMudou(GuiPainel, txtErroTitulo, total > 0 ? "cFF6666" : "c66FF99")

    Loop txtErroLinhas.Length {
        idx := A_Index
        linha := txtErroLinhas[idx]

        if (idx <= total) {
            item := lista[idx]
            g_erroMap[idx] := item.pasta
            AplicarTextoVisualSeMudou(GuiPainel, linha, idx ". " item.pedido " - " item.arquivo)
            AplicarCorVisualSeMudou(GuiPainel, linha, "cFF6666")
        } else {
            AplicarTextoVisualSeMudou(GuiPainel, linha, "")
        }
    }
}

AbrirErroPedido(indice, *) {
    global g_erroMap

    if !g_erroMap.Has(indice)
        return

    pasta := g_erroMap[indice]

    if DirExist(pasta) {
        try {
            FileAppend("visto em " FormatTime(, "yyyy-MM-dd HH:mm:ss"), pasta "\painel_erro_visto.txt", "UTF-8")
        }
        Run('explorer.exe "' pasta '"')
        AtualizarPainel()
    }
}

MarcarErrosResolvidos(*) {
    global PEDIDOS_DIR, g_errosResolvidos, ERROS_RESOLVIDOS_FILE

    hoje := FormatTime(, "yyyyMMdd")
    erros := 0

    if DirExist(PEDIDOS_DIR) {
        Loop Files PEDIDOS_DIR "\pedido.json", "FR" {
            pasta := A_LoopFileDir
            nome := NomePedidoDaPasta(pasta)

            temOk := FileExist(pasta "\processado_handoff.txt")
            temErro := FileExist(pasta "\erro_runner.txt") || FileExist(pasta "\erro_validacao.txt")

            if (temErro && !temOk && SubStr(nome, 1, 8) = hoje)
                erros++
        }
    }

    g_errosResolvidos := erros
    try FileDelete(ERROS_RESOLVIDOS_FILE)
    FileAppend(g_errosResolvidos, ERROS_RESOLVIDOS_FILE, "UTF-8")
    AtualizarPainel()
}

ContarArquivosSuporte() {
    global g_suporteAssinatura, g_suporteJanelaAberta, g_suporteTotalUltimoValido, g_suporteTemValorValido, g_suporteConsultaValida, g_suporteUltimoErro

    resposta := ApiGet("/bot/suporte/abertas")
    if !resposta.ok {
        g_suporteConsultaValida := false
        g_suporteUltimoErro := RotuloErroApiPainel(resposta)
        return g_suporteTemValorValido ? g_suporteTotalUltimoValido : 0
    }

    txt := resposta.body
    if !RegExMatch(txt, '"conversas"\s*:') {
        g_suporteConsultaValida := false
        g_suporteUltimoErro := "invalida"
        return g_suporteTemValorValido ? g_suporteTotalUltimoValido : 0
    }

    total := 0
    pos := 1
    assinatura := ""

    while pos := RegExMatch(txt, '"id":"([^"]*)".*?"mensagens":\[(.*?)\]', &m, pos) {
        idConv := m[1]
        mensagens := m[2]
        ultimoAutor := UltimoAutorMensagem(mensagens)

        if (ultimoAutor = "cliente") {
            total++
            assinatura .= idConv "|"
        }

        pos += StrLen(m[0])
    }

    assinatura .= "|" total

    if (g_suporteAssinatura != "" && assinatura != g_suporteAssinatura) {
        SoundBeep(1100, 180)
        SoundBeep(1400, 180)
    }

    g_suporteAssinatura := assinatura
    g_suporteTotalUltimoValido := total
    g_suporteTemValorValido := true
    g_suporteConsultaValida := true
    g_suporteUltimoErro := ""
    return total
}

UltimoAutorMensagem(txt) {
    ultimo := ""
    pos := 1

    while pos := RegExMatch(txt, '"autor":"([^"]*)"', &m, pos) {
        ultimo := JsonLimpar(m[1])
        pos += StrLen(m[0])
    }

    return ultimo
}

CarregarBotTokenPainel() {
    global BOT_TOKEN_FILE

    if !FileExist(BOT_TOKEN_FILE)
        return ""

    try return Trim(FileRead(BOT_TOKEN_FILE, "UTF-8"))
    catch
        return ""
}

ApiGet(endpoint) {
    global API_BASE

    tokenApi := CarregarBotTokenPainel()
    if (tokenApi = "")
        return {ok:false, status:0, kind:"missing_token", body:""}

    try {
        whr := ComObject("WinHttp.WinHttpRequest.5.1")
        whr.SetTimeouts(2000, 3000, 3000, 5000)
        whr.Open("GET", API_BASE endpoint, false)
        whr.SetRequestHeader("Authorization", "Bearer " tokenApi)
        whr.SetRequestHeader("Cache-Control", "no-cache")
        whr.Send()

        status := whr.Status
        body := whr.ResponseText

        if (status = 401)
            return {ok:false, status:status, kind:"unauthorized", body:""}

        if (status < 200 || status >= 300)
            return {ok:false, status:status, kind:"http_error", body:""}

        if !RespostaJsonValidaPainel(body)
            return {ok:false, status:status, kind:"invalid_response", body:""}

        return {ok:true, status:status, kind:"ok", body:body}
    } catch {
        return {ok:false, status:0, kind:"network_error", body:""}
    }
}

RespostaJsonValidaPainel(txt) {
    txt := Trim(txt)
    if (txt = "")
        return false

    primeiro := SubStr(txt, 1, 1)
    ultimo := SubStr(txt, -1)

    if !((primeiro = "{" && ultimo = "}") || (primeiro = "[" && ultimo = "]"))
        return false

    return RegExMatch(txt, '"ok"\s*:\s*true')
}

RotuloErroApiPainel(resposta) {
    if !IsObject(resposta)
        return "invalida"

    if (resposta.kind = "unauthorized")
        return "401"

    if (resposta.kind = "network_error")
        return "offline"

    if (resposta.kind = "invalid_response")
        return "invalida"

    if (resposta.kind = "missing_token")
        return "sem token"

    if (resposta.kind = "http_error")
        return "HTTP " resposta.status

    return "erro"
}

JsonEscape(txt) {
    txt := StrReplace(txt, "\", "\\")
    txt := StrReplace(txt, '"', '\"')
    txt := StrReplace(txt, "`r", "")
    txt := StrReplace(txt, "`n", "\n")
    return txt
}

ApiPostJson(endpoint, jsonBody) {
    global API_BASE

    tokenApi := CarregarBotTokenPainel()
    if (tokenApi = "")
        return {ok:false, status:0, kind:"missing_token", body:""}

    try {
        whr := ComObject("WinHttp.WinHttpRequest.5.1")
        whr.SetTimeouts(2000, 3000, 3000, 5000)
        whr.Open("POST", API_BASE endpoint, false)
        whr.SetRequestHeader("Authorization", "Bearer " tokenApi)
        whr.SetRequestHeader("Content-Type", "application/json")
        whr.Send(jsonBody)

        status := whr.Status
        body := whr.ResponseText

        if (status = 401)
            return {ok:false, status:status, kind:"unauthorized", body:""}

        if (status < 200 || status >= 300)
            return {ok:false, status:status, kind:"http_error", body:""}

        if !RespostaJsonValidaPainel(body)
            return {ok:false, status:status, kind:"invalid_response", body:""}

        return {ok:true, status:status, kind:"ok", body:body}
    } catch {
        return {ok:false, status:0, kind:"network_error", body:""}
    }
}

BaixarUmSuporteEAbrirPainel(*) {
    global g_suporteResolvidos, SUPORTE_RESOLVIDOS_FILE

    g_suporteResolvidos += 1

    try FileDelete(SUPORTE_RESOLVIDOS_FILE)
    FileAppend(g_suporteResolvidos, SUPORTE_RESOLVIDOS_FILE, "UTF-8")

    AtualizarPainel()
    AbrirSuportePainel()
}

AbrirSuportePainel(*) {
    global g_suporteJanelaAberta

    g_suporteJanelaAberta := true

    guiS := Gui("+AlwaysOnTop +Resize")
    estadoJanela := {ativa:true, gui:guiS, timer:""}
    guiS.BackColor := "F8FAFC"
    guiS.SetFont("s9 c111827", "Segoe UI")
    guiS.Title := "Suporte IA4Tube"

    guiS.AddText("x10 y10 w760 h24 c15803D", "CLIENTES ONLINE")
    editOnline := guiS.AddEdit("x10 y36 w760 h140 ReadOnly -Wrap c111827 BackgroundFFFFFF")

    guiS.AddText("x10 y190 w760 h24 cB45309", "CHAMADOS ABERTOS")

    listaConversas := guiS.AddListView("x10 y216 w760 h230 Grid -Multi", ["Cliente","Status","Ultima acao","ID"])
    listaConversas.ModifyCol(1, 180)
    listaConversas.ModifyCol(2, 120)
    listaConversas.ModifyCol(3, 280)
    listaConversas.ModifyCol(4, 160)

    guiS.AddText("x10 y458 w760 h20 c111827", "Cole ID do pedido, WhatsApp ou ID da conversa. Depois clique em Abrir conversa:")
    idEdit := guiS.AddEdit("x10 y482 w560 h26 c111827 BackgroundFFFFFF")

    listaConversas.OnEvent("ItemSelect", (ctrl, linha, selecionado) => SelecionarConversaLista(ctrl, linha, selecionado, idEdit))
    listaConversas.OnEvent("DoubleClick", (ctrl, linha) => (
        SelecionarConversaLista(ctrl, linha, true, idEdit),
        AbrirConversaSuporte(idEdit.Value)
    ))

    btnAbrirConversa := guiS.AddButton("x580 y480 w190 h30", "Abrir conversa")
    btnAbrirConversa.OnEvent("Click", (*) => AbrirConversaSuporte(idEdit.Value))

    btnAtualizar := guiS.AddButton("x10 y526 w150 h32", "Atualizar")
    btnAtualizar.OnEvent("Click", (*) => AtualizarSuportePainelCompleto(editOnline, listaConversas, estadoJanela))

    guiS.OnEvent("Close", FecharJanelaSuportePainel.Bind(estadoJanela))

    AtualizarSuportePainelCompleto(editOnline, listaConversas, estadoJanela)
    timerCallback := () => AtualizarSuportePainelTimer(estadoJanela, editOnline, listaConversas)
    estadoJanela.timer := timerCallback
    SetTimer(timerCallback, 5000)

    guiS.Show("w785 h580")
}

JanelaPainelAtiva(estadoJanela) {
    if !IsObject(estadoJanela)
        return false

    try {
        if !estadoJanela.ativa || !IsObject(estadoJanela.gui)
            return false

        hwnd := estadoJanela.gui.Hwnd
        return hwnd && DllCall("IsWindow", "Ptr", hwnd, "Int")
    } catch {
        return false
    }
}

PararTimerJanelaPainel(estadoJanela) {
    if !IsObject(estadoJanela)
        return

    try estadoJanela.ativa := false

    timerCallback := ""
    try timerCallback := estadoJanela.timer
    try estadoJanela.timer := ""

    if IsObject(timerCallback) {
        try SetTimer(timerCallback, 0)
    }

    try estadoJanela.gui := ""
}

FecharJanelaSuportePainel(estadoJanela, *) {
    global g_suporteJanelaAberta

    PararTimerJanelaPainel(estadoJanela)
    g_suporteJanelaAberta := false
    AtualizarPainel()
}

AtualizarSuportePainelTimer(estadoJanela, editOnline, listaConversas) {
    global g_suporteJanelaAberta

    if !JanelaPainelAtiva(estadoJanela) {
        PararTimerJanelaPainel(estadoJanela)
        g_suporteJanelaAberta := false
        return
    }

    AtualizarSuportePainelCompleto(editOnline, listaConversas, estadoJanela)
}

AtualizarSuportePainel(edit) {
    resposta := ApiGet("/bot/suporte/abertas")
    if (resposta.ok && RegExMatch(resposta.body, '"conversas"\s*:'))
        edit.Value := FormatarChamadosSuporte(resposta.body)
}

AtualizarSuportePainelCompleto(editOnline, listaConversas, estadoJanela := "") {
    global g_listaConversasIds

    try {
        if !IsObject(editOnline)
            return

        if !IsObject(listaConversas)
            return

        if (IsObject(estadoJanela) && !JanelaPainelAtiva(estadoJanela))
            return

        online := ApiGet("/bot/online")

        if (IsObject(estadoJanela) && !JanelaPainelAtiva(estadoJanela))
            return

        abertas := ApiGet("/bot/suporte/abertas")

        if (IsObject(estadoJanela) && !JanelaPainelAtiva(estadoJanela))
            return

        if (online.ok && RegExMatch(online.body, '"usuarios"\s*:'))
            try editOnline.Value := FormatarOnlineSuporte(online.body)

        if (abertas.ok && RegExMatch(abertas.body, '"conversas"\s*:')) {
            try {
                listaConversas.Delete()
                g_listaConversasIds := Map()

                pos := 1

                while pos := RegExMatch(abertas.body, '"id":"([^"]*)".*?"nome_time":"([^"]*)".*?"status":"([^"]*)".*?"ultima_atualizacao":"([^"]*)"', &m, pos) {

                    idConv := JsonLimpar(m[1])
                    nome := JsonLimpar(m[2])
                    status := JsonLimpar(m[3])
                    ultima := HoraBrasilIso(JsonLimpar(m[4]))

                    row := listaConversas.Add("", nome, status, ultima, idConv)
                    g_listaConversasIds[row] := idConv

                    pos += StrLen(m[0])
                }
            }
        }
    } catch {
    }
}

SelecionarConversaLista(ctrl, linha, selecionado, idEdit := "") {
    global g_listaConversasIds, g_conversaSelecionadaId

    try {
        if (!selecionado)
            return

        if g_listaConversasIds.Has(linha)
            g_conversaSelecionadaId := g_listaConversasIds[linha]
        else
            g_conversaSelecionadaId := ctrl.GetText(linha, 4)

        if IsObject(idEdit)
            idEdit.Value := g_conversaSelecionadaId
    } catch {
    }
}

AbrirConversaLista(ctrl, linha := 0) {
    global g_listaConversasIds, g_conversaSelecionadaId

    try {
        idConv := Trim(g_conversaSelecionadaId)

        if (idConv = "") {
            if (!linha)
                linha := ctrl.GetNext(0)

            if (!linha)
                linha := ctrl.GetNext(0, "Focused")

            if (linha && g_listaConversasIds.Has(linha))
                idConv := g_listaConversasIds[linha]
            else if (linha)
                idConv := ctrl.GetText(linha, 4)
        }

        if (Trim(idConv) != "")
            AbrirConversaSuporte(idConv)
        else
            MsgBox("Selecione uma conversa primeiro.")
    } catch {
        MsgBox("Nao consegui abrir essa conversa.")
    }
}

FormatarOnlineSuporte(online) {
    saida := ""
    pos := 1

    while pos := RegExMatch(online, '"cliente_id":"([^"]*)".*?"nome_time":"([^"]*)".*?"ultima_atividade":"([^"]*)".*?"pagina_atual":"([^"]*)".*?"produto_atual":"([^"]*)".*?"ultima_acao":"([^"]*)".*?"campo_atual":"([^"]*)".*?"tempo_inativo_ms":([0-9]+)', &m, pos) {
        idCliente := JsonLimpar(m[1])
        nome := JsonLimpar(m[2])
        ultimaAtividade := JsonLimpar(m[3])
        pagina := JsonLimpar(m[4])
        produto := JsonLimpar(m[5])
        acao := JsonLimpar(m[6])
        campo := JsonLimpar(m[7])
        tempoMs := Number(m[8])

        if (nome = "")
            nome := "Cliente"

        tempoSeg := Round(tempoMs / 1000)

        saida .= "ONLINE: " nome "`n"
        saida .= "ID: " idCliente "`n"
        saida .= "Pagina: " pagina "`n"
        saida .= "Produto: " produto "`n"
        ultimaHora := HoraBrasilIso(ultimaAtividade)

        saida .= "Ultima acao: " acao "`n"
        saida .= "Campo atual: " (campo != "" ? campo : "-") "`n"
        saida .= "Ultima atividade: " ultimaHora "`n"
        saida .= "Inativo: " tempoSeg "s`n"
        saida .= "----------------------------------------`n"

        pos += StrLen(m[0])
    }

    return Trim(saida) != "" ? saida : "Nenhum cliente online."
}

FormatarChamadosSuporte(abertas) {
    saida := ""
    pos := 1

    while pos := RegExMatch(abertas, '"id":"([^"]*)".*?"nome_time":"([^"]*)".*?"status":"([^"]*)".*?"precisa_humano":(true|false).*?"mensagens":\[(.*?)\]', &m, pos) {
        idConv := JsonLimpar(m[1])
        nome := JsonLimpar(m[2])
        status := JsonLimpar(m[3])
        precisa := m[4]
        mensagens := m[5]

        ultimaMsg := ExtrairUltimaMensagem(mensagens)

        saida .= "CLIENTE: " nome "`n"
        saida .= "STATUS: " status "`n"
        saida .= "HUMANO: " (precisa = "true" ? "SIM" : "nao") "`n"
        saida .= "ULTIMA MSG: " ultimaMsg "`n"
        saida .= "ABRIR CONVERSA -> " idConv "`n"
        saida .= "----------------------------------------`n`n"

        pos += StrLen(m[0])
    }

    return Trim(saida) != "" ? saida : "Nenhum chamado aberto."
}

ExtrairUltimaMensagem(txt) {
    ultima := ""
    pos := 1

    while pos := RegExMatch(txt, '"texto":"([^"]*)"', &m, pos) {
        ultima := JsonLimpar(m[1])
        pos += StrLen(m[0])
    }

    return ultima != "" ? ultima : "-"
}

JsonLimpar(txt) {
    txt := StrReplace(txt, '\"', '"')
    txt := StrReplace(txt, "\n", " ")
    txt := StrReplace(txt, "\r", " ")
    txt := StrReplace(txt, "\\", "\")
    return txt
}

HoraBrasilIso(iso) {
    try {
        if !InStr(iso, "T")
            return "-"

        partes := StrSplit(iso, "T")
        data := partes[1]
        hora := SubStr(StrReplace(partes[2], "Z", ""), 1, 8)

        hh := Integer(SubStr(hora, 1, 2))
        mm := SubStr(hora, 4, 2)
        ss := SubStr(hora, 7, 2)

        hh -= 3
        if (hh < 0)
            hh += 24

        return Format("{:02}:{:02}:{:02}", hh, Integer(mm), Integer(ss))
    } catch {
        return "-"
    }
}

ResponderSuporteCliente(conversaId, mensagem, edit := "") {
    conversaId := Trim(conversaId)
    mensagem := Trim(mensagem)

    if (conversaId = "" || mensagem = "") {
        MsgBox("Preencha o ID da conversa e a resposta.")
        return false
    }

    body := '{"destino":"' JsonEscape(conversaId) '","mensagem":"' JsonEscape(mensagem) '"}'
    resp := ApiPostJson("/bot/suporte/enviar-cliente", body)

    if !resp.ok {
        MsgBox("Falha ao enviar resposta: " RotuloErroApiPainel(resp) ".")
        return false
    }

    if IsObject(edit) {
        AtualizarSuportePainel(edit)
    }

    return true
}

AbrirConversaSelecionada(editChamados) {
    try {
        texto := editChamados.Text
    } catch {
        return
    }

    linha := ""

    try {
        linha := editChamados.Value
    } catch {
    }

    if (linha = "")
        linha := texto

    if RegExMatch(linha, '(\d{10,})', &m) {
        AbrirConversaSuporte(m[1])
    }
}

AbrirConversaSuporte(conversaId) {
    conversaId := Trim(conversaId)

    try {
        arquivoLidos := BASE_DIR "\suportes_lidos.txt"
        jaExiste := false

        if FileExist(arquivoLidos) {
            conteudoLidos := FileRead(arquivoLidos, "UTF-8")

            if InStr("`n" conteudoLidos "`n", "`n" conversaId "`n")
                jaExiste := true
        }

        if !jaExiste {
            FileAppend(conversaId "`n", arquivoLidos, "UTF-8")
            AtualizarPainel()
        }
    } catch {
    }

    try {
        ApiPostJson("/bot/suporte/" conversaId "/assumir", "{}")
    } catch {
    }

    if (conversaId = "") {
        MsgBox("Cole o ID da conversa primeiro.")
        return
    }

    guiC := Gui("+AlwaysOnTop +Resize")
    estadoJanela := {ativa:true, gui:guiC, timer:""}
    guiC.BackColor := "F8FAFC"
    guiC.SetFont("s9 c111827", "Segoe UI")
    guiC.Title := "Conversa IA4Tube"

    guiC.AddText("x10 y10 w760 h22 c111827", "Conversa aberta: " conversaId "  |  ENTER envia mensagem")
    conversaEdit := guiC.AddEdit("x10 y38 w760 h420 ReadOnly -Wrap c111827 BackgroundFFFFFF")

    guiC.AddText("x10 y474 w760 h20 c111827", "Sua resposta:")
    msgEdit := guiC.AddEdit("x10 y498 w760 h34 -WantReturn c111827 BackgroundFFFFFF")

; Enter envia pelo botao padrao

    btnEnviar := guiC.AddButton("x10 y545 w160 h34 Default", "Enviar resposta")
    btnEnviar.OnEvent("Click", (*) => EnviarRespostaConversaPainel(conversaId, msgEdit, conversaEdit, estadoJanela))

    btnAtualizar := guiC.AddButton("x180 y600 w120 h34", "Atualizar")
    btnAtualizar.OnEvent("Click", (*) => AtualizarConversaSuporte(conversaId, conversaEdit, estadoJanela))

    guiC.OnEvent("Close", FecharJanelaConversaPainel.Bind(estadoJanela))

    AtualizarConversaSuporte(conversaId, conversaEdit, estadoJanela)
    timerCallback := () => AtualizarConversaSuporteTimer(estadoJanela, conversaId, conversaEdit)
    estadoJanela.timer := timerCallback
    SetTimer(timerCallback, 3000)

    guiC.Show("w785 h655")
}

FecharJanelaConversaPainel(estadoJanela, *) {
    PararTimerJanelaPainel(estadoJanela)
}

EnviarRespostaConversaPainel(conversaId, msgEdit, conversaEdit, estadoJanela) {
    if !JanelaPainelAtiva(estadoJanela)
        return

    if !ResponderSuporteCliente(conversaId, msgEdit.Value)
        return

    if !JanelaPainelAtiva(estadoJanela)
        return

    msgEdit.Value := ""
    AtualizarConversaSuporte(conversaId, conversaEdit, estadoJanela)
}

AtualizarConversaSuporteTimer(estadoJanela, conversaId, conversaEdit) {
    if !JanelaPainelAtiva(estadoJanela) {
        PararTimerJanelaPainel(estadoJanela)
        return
    }

    AtualizarConversaSuporte(conversaId, conversaEdit, estadoJanela)
}

AtualizarConversaSuporte(conversaId, conversaEdit, estadoJanela := "") {
    try {
        if (IsObject(estadoJanela) && !JanelaPainelAtiva(estadoJanela))
            return

        resposta := ApiGet("/bot/suporte/abertas")

        if !resposta.ok
            return

        if !RegExMatch(resposta.body, '"conversas"\s*:')
            return

        if (IsObject(estadoJanela) && !JanelaPainelAtiva(estadoJanela))
            return

        bloco := ""
        pattern := '"id":"' conversaId '".*?"mensagens":\[(.*?)\]'
        if RegExMatch(resposta.body, pattern, &m) {
            bloco := m[1]
        }

        if (bloco = "") {
            conversaEdit.Value := "Conversa nao encontrada ou ja finalizada."
            return
        }

        saida := ""
        pos := 1

        while pos := RegExMatch(bloco, '"autor":"([^"]*)".*?"texto":"([^"]*)"', &msg, pos) {
            autor := JsonLimpar(msg[1])
            texto := JsonLimpar(msg[2])

            if (autor = "cliente")
                saida .= "CLIENTE:`n" texto "`n`n"
            else if (autor = "humano")
                saida .= "VOCE:`n" texto "`n`n"
            else
                saida .= "IA4Tube:`n" texto "`n`n"

            pos += StrLen(msg[0])
        }

        conversaEdit.Value := Trim(saida) != "" ? saida : "Sem mensagens."

        ; rolar para ultima mensagem sem travar
        SendMessage(0x115, 7, 0, conversaEdit.Hwnd)
    } catch {
    }
}

MarcarSuporteResolvido(*) {
    global g_suporteResolvidos, g_suporteConsultaValida, SUPORTE_RESOLVIDOS_FILE

    suporteTotal := ContarArquivosSuporte()
    if !g_suporteConsultaValida
        return

    g_suporteResolvidos := suporteTotal
    try FileDelete(SUPORTE_RESOLVIDOS_FILE)
    FileAppend(g_suporteResolvidos, SUPORTE_RESOLVIDOS_FILE, "UTF-8")
    AtualizarPainel()
}

MinimizarPainel(*) {
    global GuiPainel, g_minimizado, txtTitulo, txtStatus

    g_minimizado := !g_minimizado
    InvalidarCacheVisual(GuiPainel)

    if (g_minimizado) {
        txtTitulo.Move(8, 4, 145, 18)
        AplicarTextoVisualSeMudou(GuiPainel, txtStatus, "")
        GuiPainel.Show("w220 h24 NoActivate")
    } else {
        txtTitulo.Move(8, 4, 65, 18)
        AplicarTextoVisualSeMudou(GuiPainel, txtTitulo, "IA4Tube")
        AplicarCorVisualSeMudou(GuiPainel, txtTitulo, "cFFFFFF")
        GuiPainel.Show("w220 h950 NoActivate")
        AtualizarPainel()
    }
}

AbrirDetalhes(*) {
    global PEDIDOS_DIR

    gui2 := Gui("+AlwaysOnTop +Resize")
    gui2.SetFont("s9", "Segoe UI")

    txt := ""

    if DirExist(PEDIDOS_DIR) {
        Loop Files PEDIDOS_DIR "\pedido.json", "FR" {
            pasta := A_LoopFileDir
            nome := NomePedidoDaPasta(pasta)

            if FileExist(pasta "\processando.lock")
                txt .= "PROCESSANDO: " nome "`n"

            if ((FileExist(pasta "\erro_runner.txt") || FileExist(pasta "\erro_validacao.txt")) && !FileExist(pasta "\processado_handoff.txt"))
                txt .= "ERRO: " nome "`n"

            if FileExist(pasta "\processado_handoff.txt")
                txt .= "OK: " nome "`n"
        }
    }

    gui2.AddEdit("w500 h400 ReadOnly", txt)
    gui2.Show("w520 h420")
}

NomePedidoDaPasta(pasta) {
    SplitPath(pasta, &nome)
    return nome
}

LerStatusPedido(pasta) {
    statusPath := pasta "\status.txt"
    if !FileExist(statusPath)
        return ""

    try return Trim(FileRead(statusPath, "UTF-8"))
    catch
        return ""
}

ColetarStatsMateriaisGraficos() {
    global MATERIAIS_GRAFICOS_DIR

    stats := {pendentes:0, processando:0, hoje:0, erros:0, ultimo:""}
    ultimoTempo := ""
    hoje := FormatTime(, "yyyyMMdd")

    if !DirExist(MATERIAIS_GRAFICOS_DIR)
        return stats

    Loop Files MATERIAIS_GRAFICOS_DIR "\solicitacao.json", "FR" {
        pasta := A_LoopFileDir
        status := StrLower(LerStatusMaterialGrafico(pasta))
        temLock := FileExist(pasta "\processando.lock")
        temResultado := FileExist(pasta "\resultado_final.png")
        temOk := FileExist(pasta "\processado_handoff.txt")

        if ((status = "" || status = "novo") && !temLock && !temResultado && !temOk)
            stats.pendentes++

        if (temLock || InStr(status, "processando") || InStr(status, "em_producao"))
            stats.processando++

        if InStr(status, "erro")
            stats.erros++

        if (ArquivoMaterialGraficoHoje(pasta "\resultado_final.png", hoje) || ArquivoMaterialGraficoHoje(pasta "\processado_handoff.txt", hoje))
            stats.hoje++

        ultimoMg := ObterUltimoMaterialGrafico(pasta, A_LoopFileFullPath)
        if (ultimoMg.tempo != "" && (ultimoTempo = "" || StrCompare(ultimoMg.tempo, ultimoTempo) > 0)) {
            ultimoTempo := ultimoMg.tempo
            stats.ultimo := ultimoMg.nome
        }
    }

    return stats
}

ColetarStatsCarrosseis() {
    global CARROSSEIS_DIR

    stats := {pendentes:0, processando:0, hoje:0, erros:0, ultimo:""}
    ultimoTempo := ""
    hoje := FormatTime(, "yyyyMMdd")

    if !DirExist(CARROSSEIS_DIR)
        return stats

    Loop Files CARROSSEIS_DIR "\solicitacao.json", "FR" {
        pasta := A_LoopFileDir
        status := StrLower(LerStatusCarrossel(pasta))
        temLock := FileExist(pasta "\processando.lock")
        temResultado := FileExist(pasta "\resultado.zip")
        temOk := FileExist(pasta "\processado_handoff.txt")
        temErro := FileExist(pasta "\erro.txt")

        if ((status = "" || status = "novo" || status = "pendente" || status = "baixado") && !temLock && !temResultado && !temOk)
            stats.pendentes++

        if (temLock || InStr(status, "processando"))
            stats.processando++

        if (InStr(status, "erro") || (temErro && !temResultado && !temOk))
            stats.erros++

        if (ArquivoCarrosselHoje(pasta "\resultado.zip", hoje) || ArquivoCarrosselHoje(pasta "\processado_handoff.txt", hoje))
            stats.hoje++

        ultimoCar := ObterUltimoCarrossel(pasta, A_LoopFileFullPath)
        if (ultimoCar.tempo != "" && (ultimoTempo = "" || StrCompare(ultimoCar.tempo, ultimoTempo) > 0)) {
            ultimoTempo := ultimoCar.tempo
            stats.ultimo := ultimoCar.nome
        }
    }

    return stats
}

ColetarStatsPlanejamentoMensal() {
    global PLANEJAMENTOS_DIR

    stats := {pendentes:0, processando:0, hoje:0, erros:0, ultimo:"", ultimaAnalise:""}
    ultimoTempo := ""
    ultimaAnaliseTempo := ""
    hoje := FormatTime(, "yyyyMMdd")

    if !DirExist(PLANEJAMENTOS_DIR)
        return stats

    Loop Files PLANEJAMENTOS_DIR "\solicitacao.json", "FR" {
        pasta := A_LoopFileDir
        status := StrLower(LerStatusPlanejamento(pasta))
        temLock := FileExist(pasta "\processando.lock")
        temPlano := FileExist(pasta "\plano_mensal.json")
        temPedidos := FileExist(pasta "\pedidos_criados.json")
        temErro := FileExist(pasta "\erro.txt")
        cancelado := InStr(status, "cancelado")

        if ((status = "" || status = "novo" || status = "pendente" || status = "em_analise" || status = "baixado") && !temLock && !temPlano && !temErro && !cancelado)
            stats.pendentes++

        if (temLock || InStr(status, "processando"))
            stats.processando++

        if (InStr(status, "erro") || (temErro && !temPlano && !temPedidos))
            stats.erros++

        if (
            ArquivoPlanejamentoHoje(pasta "\solicitacao.json", hoje)
            || ArquivoPlanejamentoHoje(pasta "\plano_mensal.json", hoje)
            || ArquivoPlanejamentoHoje(pasta "\pedidos_criados.json", hoje)
        )
            stats.hoje++

        ultimoPlan := ObterUltimoPlanejamento(pasta, A_LoopFileFullPath)
        if (ultimoPlan.tempo != "" && (ultimoTempo = "" || StrCompare(ultimoPlan.tempo, ultimoTempo) > 0)) {
            ultimoTempo := ultimoPlan.tempo
            stats.ultimo := ultimoPlan.nome
        }

        analisePlan := ObterUltimaAnalisePlanejamento(pasta "\plano_mensal.json")
        if (analisePlan.valor != "" && analisePlan.tempo != "" && (ultimaAnaliseTempo = "" || StrCompare(analisePlan.tempo, ultimaAnaliseTempo) > 0)) {
            ultimaAnaliseTempo := analisePlan.tempo
            stats.ultimaAnalise := analisePlan.valor
        }
    }

    return stats
}

ArquivoPlanejamentoHoje(caminho, hoje) {
    if !FileExist(caminho)
        return false

    try tempo := FileGetTime(caminho, "M")
    catch
        return false

    return SubStr(tempo, 1, 8) = hoje
}

ObterUltimoPlanejamento(pasta, solicitacaoPath) {
    arquivoTempo := ""

    for nomeArquivo in ["pedidos_criados.json", "plano_mensal.json", "solicitacao.json", "erro.txt"] {
        caminho := pasta "\" nomeArquivo
        if !FileExist(caminho)
            continue

        try tempo := FileGetTime(caminho, "M")
        catch
            continue

        if (arquivoTempo = "" || StrCompare(tempo, arquivoTempo) > 0)
            arquivoTempo := tempo
    }

    if (arquivoTempo = "")
        return {tempo:"", nome:""}

    nome := LerCampoJsonSimples(solicitacaoPath, "titulo")

    if (nome = "")
        nome := LerCampoJsonSimples(solicitacaoPath, "planejamento_id")

    if (nome = "")
        nome := LerCampoJsonSimples(solicitacaoPath, "id")

    if (nome = "")
        SplitPath(pasta, &nome)

    return {tempo:arquivoTempo, nome:TruncarTextoPainel(nome, 28)}
}

ObterUltimaAnalisePlanejamento(planoPath) {
    if !FileExist(planoPath)
        return {tempo:"", valor:""}

    try conteudo := FileRead(planoPath, "UTF-8")
    catch
        return {tempo:"", valor:""}

    valor := ""
    aspas := Chr(34)
    pattern := aspas "origem_analise" aspas "\s*:\s*" aspas "([^" aspas "]*)" aspas
    if RegExMatch(conteudo, pattern, &match) {
        origem := StrLower(match[1])
        valor := (origem = "openai_vision") ? "openai_vision" : "fallback"
    }

    if (valor = "")
        return {tempo:"", valor:""}

    try tempo := FileGetTime(planoPath, "M")
    catch
        tempo := ""

    return {tempo:tempo, valor:valor}
}

VisionPlanejamentoAtiva() {
    global BASE_DIR

    disabled := StrLower(Trim(EnvGet("PLANEJAMENTO_VISION_DISABLED")))
    if (disabled = "1" || disabled = "true" || disabled = "yes" || disabled = "sim")
        return false

    if (Trim(EnvGet("OPENAI_API_KEY")) != "")
        return true

    keyPath := BASE_DIR "\openai_key.txt"
    if !FileExist(keyPath)
        return false

    try conteudo := FileRead(keyPath, "UTF-8")
    catch
        return false

    for linha in StrSplit(conteudo, "`n", "`r") {
        linha := Trim(linha)
        if (linha != "" && SubStr(linha, 1, 1) != "#")
            return true
    }

    return false
}

LerStatusPlanejamento(pasta) {
    statusPath := pasta "\status.txt"
    if !FileExist(statusPath)
        return ""

    try return Trim(FileRead(statusPath, "UTF-8"))
    catch
        return ""
}

ArquivoCarrosselHoje(caminho, hoje) {
    if !FileExist(caminho)
        return false

    try tempo := FileGetTime(caminho, "M")
    catch
        return false

    return SubStr(tempo, 1, 8) = hoje
}

ObterUltimoCarrossel(pasta, solicitacaoPath) {
    arquivoTempo := ""

    for nomeArquivo in ["processado_handoff.txt", "resultado.zip"] {
        caminho := pasta "\" nomeArquivo
        if !FileExist(caminho)
            continue

        try tempo := FileGetTime(caminho, "M")
        catch
            continue

        if (arquivoTempo = "" || StrCompare(tempo, arquivoTempo) > 0)
            arquivoTempo := tempo
    }

    if (arquivoTempo = "")
        return {tempo:"", nome:""}

    nome := LerCampoJsonSimples(solicitacaoPath, "tema")

    if (nome = "")
        nome := LerCampoJsonSimples(solicitacaoPath, "carrossel_id")

    if (nome = "")
        nome := LerCampoJsonSimples(solicitacaoPath, "id")

    if (nome = "")
        SplitPath(pasta, &nome)

    return {tempo:arquivoTempo, nome:TruncarTextoPainel(nome, 30)}
}

LerStatusCarrossel(pasta) {
    statusPath := pasta "\status.txt"
    if !FileExist(statusPath)
        return ""

    try return Trim(FileRead(statusPath, "UTF-8"))
    catch
        return ""
}

LerStatusMaterialGrafico(pasta) {
    statusPath := pasta "\status.txt"
    if !FileExist(statusPath)
        return ""

    try return Trim(FileRead(statusPath, "UTF-8"))
    catch
        return ""
}

ArquivoMaterialGraficoHoje(caminho, hoje) {
    if !FileExist(caminho)
        return false

    try tempo := FileGetTime(caminho, "M")
    catch
        return false

    return SubStr(tempo, 1, 8) = hoje
}

ObterUltimoMaterialGrafico(pasta, solicitacaoPath) {
    arquivo := ""
    arquivoTempo := ""

    for nomeArquivo in ["processado_handoff.txt", "resultado_final.png"] {
        caminho := pasta "\" nomeArquivo
        if !FileExist(caminho)
            continue

        try tempo := FileGetTime(caminho, "M")
        catch
            continue

        if (arquivoTempo = "" || StrCompare(tempo, arquivoTempo) > 0) {
            arquivoTempo := tempo
            arquivo := caminho
        }
    }

    if (arquivo = "")
        return {tempo:"", nome:""}

    nome := LerCampoJsonSimples(solicitacaoPath, "title")

    if (nome = "")
        nome := LerCampoJsonSimples(solicitacaoPath, "material_id")

    if (nome = "")
        SplitPath(pasta, &nome)

    return {tempo:arquivoTempo, nome:TruncarTextoPainel(nome, 28)}
}

LerCampoJsonSimples(arquivo, campo) {
    if !FileExist(arquivo)
        return ""

    try conteudo := FileRead(arquivo, "UTF-8")
    catch
        return ""

    aspas := Chr(34)
    pattern := aspas campo aspas "\s*:\s*" aspas "([^" aspas "]*)" aspas

    if RegExMatch(conteudo, pattern, &match)
        return NormalizarJsonStringBasica(match[1])

    return ""
}

NormalizarJsonStringBasica(valor) {
    valor := StrReplace(valor, "\n", " ")
    valor := StrReplace(valor, "\r", " ")
    valor := StrReplace(valor, "\t", " ")
    valor := StrReplace(valor, "\/", "/")
    valor := StrReplace(valor, "\\", "\")
    return Trim(valor)
}

TruncarTextoPainel(texto, limite) {
    texto := Trim(texto)

    if (StrLen(texto) > limite)
        return SubStr(texto, 1, limite - 3) "..."

    return texto
}

IniciarBot(*) {
    global BASE_DIR

    botPath := BASE_DIR "\ia4tube-bot.ahk"

    if !FileExist(botPath) {
        MsgBox("ia4tube-bot.ahk nao encontrado em:`n" botPath)
        return false
    }

    if IsBotAtivo()
        return true

    try {
        Run('"' A_AhkPath '" "' botPath '"', BASE_DIR, "Hide")
        return true
    } catch as e {
        MsgBox("Nao consegui abrir o bot IA4Tube.`n" e.Message)
        return false
    }
}

AbrirTudo(*) {
    if IniciarBot() {
        Sleep(500)
        AtualizarPainel()
        MsgBox("IA4Tube iniciado com sucesso.")
    }
}

AbrirArtesGratisSemana(*) {
    global API_BASE, BASE_DIR

    launcherPath := BASE_DIR "\abrir_artes_gratis_semana.ahk"

    try {
        if FileExist(launcherPath) {
            Run('"' A_AhkPath '" "' launcherPath '"', BASE_DIR)
        } else {
            Run(API_BASE "/bot/free-art-campaigns/panel")
        }
    } catch as e {
        MsgBox("Nao consegui abrir o painel de Artes Gratis da Semana.`n" e.Message)
    }
}

GetProgramStatus() {
    s := {bot:false, organizador:false, runner:false, pipeline:false, runnerMg:false, pipelineMg:false, runnerCar:false, pipelineCar:false, runnerPlan:false, pipelinePlan:false, runnerPlanArt:false, pipelinePlanArt:false}

    try {
        wmi := ComObjGet("winmgmts:")
        query := "Select * from Win32_Process Where Name = 'AutoHotkey64.exe' Or Name = 'AutoHotkey32.exe' Or Name = 'AutoHotkey.exe' Or Name = 'python.exe' Or Name = 'pythonw.exe'"

        for proc in wmi.ExecQuery(query) {
            cmd := ""
            try cmd := StrLower(proc.CommandLine)

            if (InStr(cmd, "ia4tube-bot.ahk"))
                s.bot := true

            if (InStr(cmd, "ia4tube-bot.ahk"))
                s.organizador := true

            if (InStr(cmd, "runner_ia4tube.py"))
                s.runner := true

            if (InStr(cmd, "resultado_pipeline_ia4tube.py"))
                s.pipeline := true

            if (InStr(cmd, "runner_materiais_graficos.py"))
                s.runnerMg := true

            if (InStr(cmd, "pipeline_materiais_graficos.py"))
                s.pipelineMg := true

            if (InStr(cmd, "runner_carrossel.py"))
                s.runnerCar := true

            if (InStr(cmd, "pipeline_carrossel.py"))
                s.pipelineCar := true

            if (InStr(cmd, "runner_planejamento_mensal.py"))
                s.runnerPlan := true

            if (InStr(cmd, "pipeline_planejamento_mensal.py"))
                s.pipelinePlan := true

            if (InStr(cmd, "runner_artes_planejamento_mensal.py"))
                s.runnerPlanArt := true

            if (InStr(cmd, "resultado_pipeline_planejamento_mensal.py"))
                s.pipelinePlanArt := true
        }
    } catch {
    }

    return s
}

IsBotAtivo() {
    try {
        wmi := ComObjGet("winmgmts:")
        query := "Select * from Win32_Process Where Name = 'AutoHotkey64.exe' Or Name = 'AutoHotkey32.exe' Or Name = 'AutoHotkey.exe'"

        for proc in wmi.ExecQuery(query) {
            cmd := ""
            try cmd := proc.CommandLine

            if (InStr(StrLower(cmd), "ia4tube-bot.ahk"))
                return true
        }
    } catch {
        return false
    }

    return false
}

FecharBot(*) {
    try {
        wmi := ComObjGet("winmgmts:")
        query := "Select * from Win32_Process Where Name = 'python.exe' Or Name = 'pythonw.exe' Or Name = 'AutoHotkey64.exe' Or Name = 'AutoHotkey32.exe' Or Name = 'AutoHotkey.exe'"

        for proc in wmi.ExecQuery(query) {
            cmd := ""
            try cmd := proc.CommandLine

            cmdLower := StrLower(cmd)

            if (
                InStr(cmdLower, "ia4tube-bot.ahk")
                || InStr(cmdLower, "runner_ia4tube.py")
                || InStr(cmdLower, "resultado_pipeline_ia4tube.py")
            )
                proc.Terminate()
        }
    } catch {
    }
}

FecharTudo(){
    atualPid := DllCall("GetCurrentProcessId", "UInt")

    try {
        wmi := ComObjGet("winmgmts:")
        query := "Select * from Win32_Process Where Name = 'python.exe' Or Name = 'pythonw.exe' Or Name = 'AutoHotkey64.exe' Or Name = 'AutoHotkey32.exe' Or Name = 'AutoHotkey.exe'"

        for proc in wmi.ExecQuery(query) {
            pid := 0
            cmd := ""

            try pid := proc.ProcessId
            try cmd := StrLower(proc.CommandLine)

            if (pid = atualPid)
                continue

            if IsProcessoIa4Tube(cmd) {
                try proc.Terminate()
            }
        }
    } catch {
    }

    Sleep(500)
    MsgBox("Todos os processos IA4Tube foram encerrados.")
    ExitApp()
}

IsProcessoIa4Tube(cmd) {
    global BASE_DIR

    cmd := StrLower(cmd)
    baseDirLower := StrLower(BASE_DIR)

    if (cmd = "")
        return false

    if (baseDirLower != "" && InStr(cmd, baseDirLower))
        return true

    return (
        InStr(cmd, "ia4tube-bot.ahk")
        || InStr(cmd, "painel_ia4tube.ahk")
        || InStr(cmd, "runner_ia4tube.py")
        || InStr(cmd, "resultado_pipeline_ia4tube.py")
        || InStr(cmd, "runner_materiais_graficos.py")
        || InStr(cmd, "pipeline_materiais_graficos.py")
        || InStr(cmd, "runner_carrossel.py")
        || InStr(cmd, "pipeline_carrossel.py")
        || InStr(cmd, "runner_planejamento_mensal.py")
        || InStr(cmd, "pipeline_planejamento_mensal.py")
        || InStr(cmd, "runner_artes_planejamento_mensal.py")
        || InStr(cmd, "resultado_pipeline_planejamento_mensal.py")
    )
}

IsRunnerAtivo() {
    try {
        wmi := ComObjGet("winmgmts:")
        query := "Select * from Win32_Process Where Name = 'python.exe' Or Name = 'pythonw.exe'"

        for proc in wmi.ExecQuery(query) {
            cmd := ""
            try cmd := proc.CommandLine

            if (InStr(StrLower(cmd), "runner_ia4tube.py"))
                return true
        }
    } catch {
        return false
    }

    return false
}
