package br.com.ia4tube.app.data.api

import android.util.Log
import br.com.ia4tube.app.core.config.AppConfig
import br.com.ia4tube.app.data.models.AdjustmentResult
import br.com.ia4tube.app.data.models.AppVersionInfo
import br.com.ia4tube.app.data.models.ApiResult
import br.com.ia4tube.app.data.models.BalancePaymentResult
import br.com.ia4tube.app.data.models.BillingPixResult
import br.com.ia4tube.app.data.models.CarouselRequest
import br.com.ia4tube.app.data.models.CarouselRequestResponse
import br.com.ia4tube.app.data.models.CarouselListResponse
import br.com.ia4tube.app.data.models.CarouselStatus
import br.com.ia4tube.app.data.models.CarouselStatusResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterial
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialProfileRequest
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialRequestResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialStatusResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialsLimits
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialsListResponse
import br.com.ia4tube.app.data.models.CompanyGraphicMaterialsPlan
import br.com.ia4tube.app.data.models.CreateArtEmpresaRequest
import br.com.ia4tube.app.data.models.CreateOrderResponse
import br.com.ia4tube.app.data.models.DownloadedFile
import br.com.ia4tube.app.data.models.DownloadedImage
import br.com.ia4tube.app.data.models.FootballOrderRequest
import br.com.ia4tube.app.data.models.LoginResponse
import br.com.ia4tube.app.data.models.MeResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningDetailDto
import br.com.ia4tube.app.data.models.MonthlyPlanningPostDto
import br.com.ia4tube.app.data.models.MonthlyPlanningRequest
import br.com.ia4tube.app.data.models.MonthlyPlanningRequestResponse
import br.com.ia4tube.app.data.models.MonthlyPlanningSummaryDto
import br.com.ia4tube.app.data.models.OrderInfo
import br.com.ia4tube.app.data.models.OrderSummary
import br.com.ia4tube.app.data.models.PaymentInfo
import br.com.ia4tube.app.data.models.SendSupportMessageResponse
import br.com.ia4tube.app.data.models.SupportMessage
import br.com.ia4tube.app.data.models.SupportSender
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.TimeUnit

class IA4TubeApiClient(
    private val client: OkHttpClient = defaultClient()
) {
    suspend fun appVersion(): ApiResult<AppVersionInfo> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/app/version")
            .get()
            .build()

        executeJson(request) { json ->
            AppVersionInfo(
                latestVersionCode = json.optInt("latest_version_code", 0),
                minimumVersionCode = json.optInt("minimum_version_code", 0),
                latestVersionName = json.optString("latest_version_name"),
                updateRequired = json.optBoolean("update_required", false),
                title = json.optString("title").ifBlank { "Nova vers\u00e3o dispon\u00edvel" },
                message = json.optString("message").ifBlank {
                    "Atualize o app para receber melhorias, corre\u00e7\u00f5es e uma experi\u00eancia mais est\u00e1vel."
                },
                playStoreUrl = json.optString("play_store_url").ifBlank {
                    "https://play.google.com/store/apps/details?id=com.ia4tube.app"
                }
            )
        }
    }

    suspend fun login(login: String, senha: String): ApiResult<LoginResponse> = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
            .put("whatsapp", login)
            .put("senha", senha)

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/auth/login")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { json ->
            LoginResponse(
                token = json.optString("token"),
                nomeTime = json.optString("nome_time"),
                saldo = json.optDouble("saldo", 0.0)
            )
        }
    }

    suspend fun register(whatsapp: String, senha: String): ApiResult<LoginResponse> = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
            .put("whatsapp", whatsapp)
            .put("senha", senha)

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/auth/register")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { json ->
            LoginResponse(
                token = json.optString("token"),
                nomeTime = json.optString("nome_time"),
                saldo = json.optDouble("saldo", 0.0)
            )
        }
    }

    suspend fun me(token: String): ApiResult<MeResponse> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/me")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            MeResponse(
                nomeTime = json.optString("nome_time"),
                saldo = json.optDouble("saldo", 0.0),
                ativo = json.optBoolean("ativo", false),
                planoAtual = json.optString("plano_atual"),
                planoStatus = json.optString("plano_status", "none"),
                planoNome = json.optString("plano_nome"),
                planoRenovaEm = json.optString("plano_renova_em"),
                artesMensaisTotal = json.optInt("artes_mensais_total", 0),
                artesMensaisUsadas = json.optInt("artes_mensais_usadas", 0),
                artesMensaisRestantes = json.optInt("artes_mensais_restantes", 0),
                artesAvulsasRestantes = json.optInt("artes_avulsas_restantes", 0),
                artesAvulsasUsadas = json.optInt("artes_avulsas_usadas", 0),
                artesAvulsasTotalCompradas = json.optInt("artes_avulsas_total_compradas", 0),
                arteAvulsaValor = json.optDouble("arte_avulsa_valor", 1.99),
                arteAvulsaProdutoId = json.optString("arte_avulsa_produto_id"),
                arteAvulsaTitulo = json.optString("arte_avulsa_titulo"),
                saldoExtra = json.optDouble("saldo_extra", 0.0),
                carrosseisLimite = json.optionalInt("carrosseis_limite"),
                carrosseisUsados = json.optionalInt("carrosseis_usados"),
                carrosseisRestantes = json.optionalInt("carrosseis_restantes"),
                carrosseisCiclo = json.optionalString("carrosseis_ciclo")
            )
        }
    }

    suspend fun saveFcmToken(token: String, fcmToken: String): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
            .put("token", fcmToken)
            .put("platform", "android")

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/me/fcm-token")
            .header("Authorization", "Bearer $token")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { Unit }
    }

    suspend fun meusPedidos(token: String): ApiResult<List<OrderSummary>> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/meus-pedidos")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            val pedidos = json.optJSONArray("pedidos")
            val planejamentos = json.optJSONArray("planejamentos")
            buildList {
                if (pedidos != null) {
                    for (index in 0 until pedidos.length()) {
                        val item = pedidos.optJSONObject(index) ?: continue
                        add(
                            OrderSummary(
                                id = item.optString("id"),
                                tipo = item.optString("tipo"),
                                status = item.optString("status"),
                                imagemPronta = item.optBoolean("imagem_pronta", false),
                                pagamentoPendente = item.optBoolean("pagamento_pendente", false),
                                createdAt = item.optString("criado_em")
                                    .ifBlank { item.optString("created_at") }
                            )
                        )
                    }
                }
                if (planejamentos != null) {
                    for (index in 0 until planejamentos.length()) {
                        val item = planejamentos.optJSONObject(index) ?: continue
                        val total = item.optInt("total_postagens", item.optInt("quantidade_reservada", 0))
                        val ready = item.optInt("prontas", item.optInt("ja_produzidas", 0))
                        add(
                            OrderSummary(
                                id = item.optString("planejamento_id").ifBlank { item.optString("id") },
                                tipo = "Planejamento Mensal",
                                status = item.optString("status_label").ifBlank { item.optString("status") },
                                imagemPronta = total > 0 && ready >= total,
                                pagamentoPendente = false,
                                isMonthlyPlanning = true,
                                planningId = item.optString("planejamento_id").ifBlank { item.optString("id") },
                                title = item.optString("titulo").ifBlank { "Planejamento Mensal" },
                                totalPosts = total,
                                readyPosts = ready,
                                productionPosts = item.optInt("em_producao", 0),
                                plannedPosts = item.optInt("planejadas", 0),
                                errorPosts = item.optInt("erros", 0)
                            )
                        )
                    }
                }
            }
        }
    }

    suspend fun listarPlanejamentosMensais(token: String): ApiResult<List<MonthlyPlanningSummaryDto>> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/planejamento-mensal")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            val planejamentos = json.optJSONArray("planejamentos") ?: JSONArray()
            buildList {
                for (index in 0 until planejamentos.length()) {
                    val item = planejamentos.optJSONObject(index) ?: continue
                    add(monthlyPlanningSummaryFromJson(item))
                }
            }
        }
    }

    suspend fun planejamentoMensalDetalhe(token: String, planningId: String): ApiResult<MonthlyPlanningDetailDto> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(planningId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/planejamento-mensal/$encodedId")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            val planning = json.optJSONObject("planejamento") ?: JSONObject()
            val planoMensal = planning.optJSONObject("plano_mensal") ?: JSONObject()
            val postsJson = planoMensal.optJSONArray("postagens")
                ?: planoMensal.optJSONArray("itens")
                ?: JSONArray()
            MonthlyPlanningDetailDto(
                summary = monthlyPlanningSummaryFromJson(planning),
                posts = buildList {
                    for (index in 0 until postsJson.length()) {
                        val item = postsJson.optJSONObject(index) ?: continue
                        add(monthlyPlanningPostFromJson(item, index + 1))
                    }
                }
            )
        }
    }

    suspend fun solicitarPlanejamentoMensal(
        token: String,
        requestData: MonthlyPlanningRequest
    ): ApiResult<MonthlyPlanningRequestResponse> = withContext(Dispatchers.IO) {
        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("quantidade_reservada", requestData.quantidadeReservada.toString())
            .addFormDataPart("nome_empresa", requestData.nomeEmpresa)
            .addFormDataPart("ramo", requestData.ramo)
            .addFormDataPart("orientacoes_fotos", monthlyPlanningPhotoOrientationsJson(requestData))

        requestData.fotos.forEach { photo ->
            val foto = photo.file
            val body = foto.bytes.toRequestBody(foto.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("fotos", foto.fileName, body)
        }

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/planejamento-mensal/solicitar")
            .header("Authorization", "Bearer $token")
            .post(multipartBuilder.build())
            .build()

        logMultipart(
            url = request.url.toString(),
            fields = listOf("quantidade_reservada", "nome_empresa", "ramo", "orientacoes_fotos", "fotos"),
            files = requestData.fotos.map { it.file }
        )

        executeJson(request) { json ->
            MonthlyPlanningRequestResponse(
                planningId = json.optString("planejamento_id"),
                ciclo = json.optString("ciclo"),
                status = json.optString("status"),
                statusLabel = json.optString("status_label").ifBlank { json.optString("status") },
                quantidadeReservada = json.optInt("quantidade_reservada", requestData.quantidadeReservada),
                artesDesteCiclo = json.optInt("artes_deste_ciclo", 0),
                reservadasNoPlanejamento = json.optInt("reservadas_no_planejamento", 0),
                livresParaCriarArte = json.optInt("livres_para_criar_arte", 0)
            )
        }
    }

    suspend fun pedidoInfo(token: String, pedidoId: String): ApiResult<OrderInfo> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/info")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            OrderInfo(
                id = json.optString("id"),
                status = json.optString("status"),
                previewUrl = json.optString("preview_url"),
                imagemPronta = json.optBoolean("imagem_pronta", false),
                aprovadoCliente = json.optBoolean("aprovado_cliente", false),
                pagamentoPendente = json.optBoolean("pagamento_pendente", false),
                valorPendente = json.optDouble("valor_pendente", 0.0),
                motivoPagamentoPendente = json.optString("motivo_pagamento_pendente"),
                descricaoInstagram = json.optString("descricao_instagram"),
                categoria = json.optString("categoria"),
                nomeEmpresa = json.optString("nome_empresa"),
                ramo = json.optString("ramo"),
                objetivo = json.optString("objetivo"),
                tipoArte = json.optString("tipo_arte"),
                fraseFoto = json.optString("frase_foto"),
                cta = json.optString("cta"),
                whatsappContato = json.optString("whatsapp_contato"),
                instagram = json.optString("instagram"),
                historiaEmpresa = json.optString("historia_empresa"),
                podeBaixar = json.optBoolean("pode_baixar", false),
                podePedirAjuste = json.optBoolean("pode_pedir_ajuste", false),
                downloadBloqueado = json.optBoolean("download_bloqueado", false),
                mensagemDownloadBloqueado = json.optString("mensagem_download_bloqueado")
            )
        }
    }

    suspend fun aprovarPedido(token: String, pedidoId: String): ApiResult<Unit> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/aprovar")
            .header("Authorization", "Bearer $token")
            .post("{}".toRequestBody(JSON))
            .build()

        executeJson(request) { Unit }
    }

    suspend fun downloadResultado(token: String, pedidoId: String): ApiResult<DownloadedImage> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/download-resultado")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeBytes(request)
    }

    suspend fun listarMateriaisGraficos(
        token: String,
        ramo: String
    ): ApiResult<CompanyGraphicMaterialsListResponse> = withContext(Dispatchers.IO) {
        val encodedRamo = URLEncoder.encode(ramo, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/materiais-graficos?ramo=$encodedRamo")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json -> companyGraphicMaterialsFromJson(json) }
    }

    suspend fun solicitarMaterialGrafico(
        token: String,
        materialId: String,
        requestData: CompanyGraphicMaterialProfileRequest
    ): ApiResult<CompanyGraphicMaterialRequestResponse> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(materialId, StandardCharsets.UTF_8.name())
        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("nome_empresa", requestData.nomeEmpresa)
            .addFormDataPart("ramo", requestData.ramo)
            .addFormDataPart("whatsapp", requestData.whatsapp)
            .addFormDataPart("instagram", requestData.instagram)
            .addFormDataPart("historia", requestData.historia)
            .addFormDataPart("endereco", requestData.endereco)
            .addFormDataPart("cidade", requestData.cidade)
            .addFormDataPart("estado", requestData.estado)
            .addFormDataPart("cep", requestData.cep)
            .addFormDataPart("email", requestData.email)
            .addFormDataPart("site", requestData.site)

        requestData.logo?.let { logo ->
            val body = logo.bytes.toRequestBody(logo.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("logo", logo.fileName, body)
        }

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/materiais-graficos/$encodedId/solicitar")
            .header("Authorization", "Bearer $token")
            .post(multipartBuilder.build())
            .build()

        executeJson(request) { json ->
            CompanyGraphicMaterialRequestResponse(
                documentId = json.optString("document_id"),
                materialId = json.optString("material_id"),
                title = json.optString("title"),
                scope = json.optString("scope"),
                ciclo = json.optString("ciclo"),
                status = json.optString("status"),
                statusLabel = json.optString("status_label")
            )
        }
    }

    suspend fun statusMaterialGrafico(token: String, materialId: String, ramo: String): ApiResult<CompanyGraphicMaterialStatusResponse> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(materialId, StandardCharsets.UTF_8.name())
        val encodedRamo = URLEncoder.encode(ramo, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/materiais-graficos/$encodedId/status?ramo=$encodedRamo")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            CompanyGraphicMaterialStatusResponse(
                material = companyGraphicMaterialFromJson(json.optJSONObject("material") ?: JSONObject()),
                ciclo = json.optString("ciclo")
            )
        }
    }

    suspend fun downloadMaterialGrafico(token: String, materialId: String): ApiResult<DownloadedImage> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(materialId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/materiais-graficos/$encodedId/download")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeBytes(request)
    }

    suspend fun solicitarCarrossel(token: String, requestData: CarouselRequest): ApiResult<CarouselRequestResponse> = withContext(Dispatchers.IO) {
        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("tema", requestData.tema)
            .addFormDataPart("briefing", requestData.briefing)
            .addFormDataPart("quantidade_telas", requestData.quantidadeTelas.toString())
            .addFormDataPart("nivel_conteudo", requestData.nivelConteudo.toString())

        requestData.logo?.let { logo ->
            val body = logo.bytes.toRequestBody(logo.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("logo", logo.fileName, body)
        }

        requestData.fotos.forEach { foto ->
            val body = foto.bytes.toRequestBody(foto.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("fotos", foto.fileName, body)
        }

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/carrosseis/solicitar")
            .header("Authorization", "Bearer $token")
            .post(multipartBuilder.build())
            .build()

        logMultipart(
            url = request.url.toString(),
            fields = listOf("tema", "briefing", "quantidade_telas", "nivel_conteudo", "logo", "fotos"),
            files = listOfNotNull(requestData.logo) + requestData.fotos
        )

        executeJson(request) { json ->
            CarouselRequestResponse(
                carrosselId = json.optString("carrossel_id"),
                ciclo = json.optString("ciclo"),
                status = json.optString("status"),
                statusLabel = json.optString("status_label")
            )
        }
    }

    suspend fun listarCarrosseis(token: String): ApiResult<CarouselListResponse> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/carrosseis")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            val items = json.optJSONArray("carrosseis") ?: JSONArray()
            CarouselListResponse(
                carousels = (0 until items.length())
                    .mapNotNull { index -> items.optJSONObject(index) }
                    .map { item -> carouselStatusFromJson(item) }
            )
        }
    }

    suspend fun statusCarrossel(token: String, carrosselId: String): ApiResult<CarouselStatusResponse> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(carrosselId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/carrosseis/$encodedId/status")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json ->
            CarouselStatusResponse(
                carousel = carouselStatusFromJson(json.optJSONObject("carrossel") ?: JSONObject())
            )
        }
    }

    suspend fun downloadCarrossel(token: String, carrosselId: String): ApiResult<DownloadedFile> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(carrosselId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/empresa/carrosseis/$encodedId/download")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeFile(request, fallbackFileName = "ia4tube_carrossel_$carrosselId.zip")
    }

    suspend fun solicitarAjuste(token: String, pedidoId: String, motivo: String): ApiResult<AdjustmentResult> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val bodyJson = JSONObject()
            .put("motivo_ajuste", motivo)

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/solicitar-ajuste")
            .header("Authorization", "Bearer $token")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { json ->
            AdjustmentResult(message = adjustmentMessage(json))
        }
    }

    suspend fun pagamentoInfo(token: String, pedidoId: String): ApiResult<PaymentInfo> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/pagamento-info")
            .header("Authorization", "Bearer $token")
            .get()
            .build()

        executeJson(request) { json -> paymentInfoFromJson(json) }
    }

    suspend fun gerarPix(token: String, pedidoId: String): ApiResult<PaymentInfo> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/gerar-pix")
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        executeJson(request) { json -> paymentInfoFromJson(json) }
    }

    suspend fun criarSaldoPix(token: String, pacote: String): ApiResult<BillingPixResult> = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
            .put("pacote", pacote)

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/billing/saldo/pix")
            .header("Authorization", "Bearer $token")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { json -> billingPixFromJson(json) }
    }

    suspend fun criarArteAvulsaPix(token: String): ApiResult<BillingPixResult> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/billing/arte-avulsa/pix")
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        executeJson(request) { json -> billingPixFromJson(json) }
    }

    suspend fun criarPlanoPix(token: String, planId: String): ApiResult<BillingPixResult> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/billing/planos/$planId/pix")
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        executeJson(request) { json -> billingPixFromJson(json) }
    }

    suspend fun pagarComSaldo(token: String, pedidoId: String): ApiResult<BalancePaymentResult> = withContext(Dispatchers.IO) {
        val encodedId = URLEncoder.encode(pedidoId, StandardCharsets.UTF_8.name())
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos/$encodedId/pagar-com-saldo")
            .header("Authorization", "Bearer $token")
            .post(ByteArray(0).toRequestBody(null))
            .build()

        executeJson(request) { json ->
            val pendente = json.optBoolean("pagamento_pendente", false)
            val message = json.optString("mensagem")
                .ifBlank {
                    if (pendente) "Pagamento ainda pendente." else "Pagamento com saldo concluído."
                }
            BalancePaymentResult(
                message = message,
                pagamentoPendente = pendente
            )
        }
    }

    suspend fun criarArteEmpresa(token: String, requestData: CreateArtEmpresaRequest): ApiResult<CreateOrderResponse> = withContext(Dispatchers.IO) {
        val fieldsJson = createArteEmpresaFieldsJson(requestData)
        val assetsJson = JSONObject()
            .put(
                "logo",
                JSONObject()
                    .put("legacyName", "logo")
                    .put("files", org.json.JSONArray().put(requestData.logo.fileName))
            )
            .put(
                "fotos",
                JSONObject()
                    .put("legacyName", "fotos")
                    .put("files", filesArray(requestData.fotos))
            )
            .put(
                "referencias",
                JSONObject()
                    .put("legacyName", "referencias")
                    .put("files", filesArray(requestData.referencias))
            )
            .put(
                "modelo_existente",
                JSONObject()
                    .put("legacyName", "modelo_existente")
                    .put("files", filesArray(listOfNotNull(requestData.modeloExistente)))
            )

        val logoBody = requestData.logo.bytes.toRequestBody(requestData.logo.contentType.toMediaTypeOrNull())
        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("flyer_tipo", "arte_empresa")
            .addFormDataPart("product_id", "arte_empresa")
            .addFormDataPart("schema_version", "2")
            .addFormDataPart("fields_json", fieldsJson.toString())
            .addFormDataPart("assets_json", assetsJson.toString())
            .addFormDataPart("ramo", requestData.ramo)
            .addFormDataPart("ramo_origem", "manual")
            .addFormDataPart("nome_empresa", requestData.nomeEmpresa)
            .addFormDataPart("objetivo", requestData.objetivo)
            .addFormDataPart("objetivo_origem", "manual")
            .addFormDataPart("estilo_visual_cliente", requestData.estiloVisualCliente)
            .addFormDataPart("oferta", requestData.oferta)
            .addFormDataPart("cta", requestData.cta)
            .addFormDataPart("whatsapp", requestData.whatsapp)
            .addFormDataPart("instagram", requestData.instagram)
            .addFormDataPart("observacoes", requestData.observacoes)
            .addFormDataPart("frase_foto", requestData.fraseFoto)
            .addFormDataPart("historia_empresa", requestData.historiaEmpresa)
            .addFormDataPart("origem_foto_rapida", if (requestData.origemFotoRapida) "1" else "")
            .addFormDataPart("rodada", requestData.rodada)
            .addFormDataPart("data", requestData.data)
            .addFormDataPart("logo", requestData.logo.fileName, logoBody)

        requestData.referencias.forEach { referencia ->
            val body = referencia.bytes.toRequestBody(referencia.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("referencias", referencia.fileName, body)
        }
        requestData.fotos.forEach { foto ->
            val body = foto.bytes.toRequestBody(foto.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("fotos", foto.fileName, body)
        }
        requestData.modeloExistente?.let { modelo ->
            val body = modelo.bytes.toRequestBody(modelo.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart("modelo_existente", modelo.fileName, body)
        }

        val multipart = multipartBuilder.build()

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/pedidos")
            .header("Authorization", "Bearer $token")
            .post(multipart)
            .build()

        logMultipart(
            url = request.url.toString(),
            fields = listOf(
                "flyer_tipo",
                "product_id",
                "schema_version",
                "fields_json",
                "assets_json",
                "ramo",
                "ramo_origem",
                "nome_empresa",
                "objetivo",
                "objetivo_origem",
                "estilo_visual_cliente",
                "oferta",
                "cta",
                "whatsapp",
                "instagram",
                "observacoes",
                "frase_foto",
                "historia_empresa",
                "origem_foto_rapida",
                "rodada",
                "data",
                "logo",
                "referencias",
                "fotos",
                "modelo_existente"
            ),
            files = listOf(requestData.logo) + requestData.referencias + requestData.fotos + listOfNotNull(requestData.modeloExistente)
        )

        executeJson(request) { json ->
            CreateOrderResponse(pedidoId = json.optString("pedido_id"))
        }
    }

    suspend fun criarPedidoFutebol(token: String, requestData: FootballOrderRequest): ApiResult<CreateOrderResponse> = withContext(Dispatchers.IO) {
        val fieldsJson = JSONObject()
        requestData.fields.forEach { (key, value) ->
            fieldsJson.put(key, value)
        }
        requestData.nestedFields.forEach { (key, value) ->
            fieldsJson.put(key, jsonValue(value))
        }

        val assetsJson = JSONObject()
        requestData.files.forEach { (fieldKey, file) ->
            assetsJson.put(
                fieldKey,
                JSONObject()
                    .put("legacyName", fieldKey)
                    .put("files", JSONArray().put(file.fileName))
            )
        }
        requestData.multiFiles.forEach { (fieldKey, files) ->
            assetsJson.put(
                fieldKey,
                JSONObject()
                    .put("legacyName", fieldKey)
                    .put("files", filesArray(files))
            )
        }

        val multipartBuilder = MultipartBody.Builder()
            .setType(MultipartBody.FORM)

        if (requestData.productKey != "escudo3d") {
            multipartBuilder
                .addFormDataPart("schema_version", "2")
                .addFormDataPart("product_id", requestData.productKey)
                .addFormDataPart("fields_json", fieldsJson.toString())
                .addFormDataPart("assets_json", assetsJson.toString())
        }

        if (requestData.flyerTipo.isNotBlank()) {
            multipartBuilder.addFormDataPart("flyer_tipo", requestData.flyerTipo)
        }

        if (requestData.nomeEmpresa.isNotBlank()) {
            multipartBuilder.addFormDataPart("nome_empresa", requestData.nomeEmpresa)
        }
        if (requestData.ramo.isNotBlank()) {
            multipartBuilder.addFormDataPart("ramo", requestData.ramo)
        }
        if (requestData.objetivo.isNotBlank()) {
            multipartBuilder.addFormDataPart("objetivo", requestData.objetivo)
        }

        requestData.fields.forEach { (key, value) ->
            multipartBuilder.addFormDataPart(key, value)
        }
        requestData.files.forEach { (key, file) ->
            val body = file.bytes.toRequestBody(file.contentType.toMediaTypeOrNull())
            multipartBuilder.addFormDataPart(key, file.fileName, body)
        }
        requestData.multiFiles.forEach { (key, files) ->
            files.forEach { file ->
                val body = file.bytes.toRequestBody(file.contentType.toMediaTypeOrNull())
                multipartBuilder.addFormDataPart(key, file.fileName, body)
            }
        }

        val request = Request.Builder()
            .url("${AppConfig.apiBase}${requestData.endpoint}")
            .header("Authorization", "Bearer $token")
            .post(multipartBuilder.build())
            .build()

        logMultipart(
            url = request.url.toString(),
            fields = listOf(
                "schema_version",
                "product_id",
                "fields_json",
                "assets_json",
                "flyer_tipo",
                "nome_empresa",
                "ramo",
                "objetivo"
            ) + requestData.fields.keys + requestData.files.keys + requestData.multiFiles.keys,
            files = requestData.files.values + requestData.multiFiles.values.flatten()
        )

        executeJson(request) { json ->
            CreateOrderResponse(pedidoId = json.optString("pedido_id"))
        }
    }

    suspend fun minhasMensagensSuporte(token: String): ApiResult<List<SupportMessage>> = withContext(Dispatchers.IO) {
        val request = Request.Builder()
            .url("${AppConfig.apiBase}/suporte/minhas-mensagens")
            .header("Authorization", "Bearer $token")
            .header("X-IA4-Chat", "true")
            .get()
            .build()

        executeJson(request) { json ->
            val mensagens = json.optJSONArray("mensagens")
            buildList {
                if (mensagens != null) {
                    for (index in 0 until mensagens.length()) {
                        val item = mensagens.optJSONObject(index) ?: continue
                        val text = item.optString("mensagem")
                            .ifBlank { item.optString("texto") }
                            .ifBlank { item.optString("conteudo") }
                        if (text.isBlank()) continue
                        add(
                            SupportMessage(
                                id = item.optString("id").ifBlank { index.toString() },
                                text = text,
                                sender = supportSenderFromJson(item),
                                createdAt = item.optString("created_at")
                                    .ifBlank { item.optString("criado_em") }
                                    .ifBlank { item.optString("data") }
                            )
                        )
                    }
                }
            }
        }
    }

    suspend fun enviarMensagemSuporte(token: String, mensagem: String): ApiResult<SendSupportMessageResponse> = withContext(Dispatchers.IO) {
        val bodyJson = JSONObject()
            .put("mensagem", mensagem)

        val request = Request.Builder()
            .url("${AppConfig.apiBase}/suporte/chat")
            .header("Authorization", "Bearer $token")
            .post(bodyJson.toString().toRequestBody(JSON))
            .build()

        executeJson(request) { json ->
            SendSupportMessageResponse(
                responseText = json.optString("resposta"),
                humanMode = json.optBoolean("modo_humano", false),
                conversationId = json.optString("conversa_id")
            )
        }
    }

    private fun <T> executeJson(request: Request, mapper: (JSONObject) -> T): ApiResult<T> {
        return try {
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                val contentType = response.header("Content-Type").orEmpty()
                val preview = text.take(500)
                Log.d(
                    TAG,
                    "HTTP ${response.code} ${request.method} ${request.url} contentType=$contentType bodyPreview=$preview"
                )

                val trimmed = text.trimStart()
                if (trimmed.isNotBlank() && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
                    return ApiResult.Failure(
                        message = CREATE_ORDER_UNAVAILABLE_MESSAGE,
                        statusCode = response.code
                    )
                }

                val json = if (text.isBlank()) JSONObject() else JSONObject(text)

                if (!response.isSuccessful || !json.optBoolean("ok", false)) {
                    return ApiResult.Failure(
                        message = json.optString("error", "Erro ao chamar API"),
                        statusCode = response.code,
                        code = json.optString("code")
                    )
                }

                ApiResult.Success(mapper(json))
            }
        } catch (error: IOException) {
            ApiResult.Failure(error.message ?: "Erro de rede")
        } catch (error: JSONException) {
            Log.e(TAG, "Erro ao interpretar resposta JSON de ${request.url}", error)
            ApiResult.Failure(CREATE_ORDER_UNAVAILABLE_MESSAGE)
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: "Erro inesperado")
        }
    }

    private fun executeBytes(request: Request): ApiResult<DownloadedImage> {
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) {
                    val errorText = body?.string().orEmpty()
                    return ApiResult.Failure(
                        message = apiErrorMessage(errorText).ifBlank { "Não foi possível baixar a imagem." },
                        statusCode = response.code
                    )
                }

                val contentType = body.contentType()?.toString().orEmpty()
                val bytes = body.bytes()

                if (bytes.isEmpty()) {
                    return ApiResult.Failure(
                        message = "A imagem veio vazia. Tente novamente.",
                        statusCode = response.code
                    )
                }

                if (!contentType.startsWith("image/", ignoreCase = true)) {
                    return ApiResult.Failure(
                        message = apiErrorMessage(String(bytes, StandardCharsets.UTF_8))
                            .ifBlank { "A resposta recebida nao era uma imagem." },
                        statusCode = response.code
                    )
                }

                ApiResult.Success(
                    DownloadedImage(
                        bytes = bytes,
                        contentType = contentType
                    )
                )
            }
        } catch (error: IOException) {
            ApiResult.Failure(error.message ?: "Erro de rede")
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: "Erro inesperado")
        }
    }

    private fun executeFile(request: Request, fallbackFileName: String): ApiResult<DownloadedFile> {
        return try {
            client.newCall(request).execute().use { response ->
                val body = response.body
                if (!response.isSuccessful || body == null) {
                    val errorText = body?.string().orEmpty()
                    return ApiResult.Failure(
                        message = apiErrorMessage(errorText).ifBlank { "NÃ£o foi possÃ­vel baixar o arquivo." },
                        statusCode = response.code
                    )
                }

                val contentType = body.contentType()?.toString().orEmpty()
                val bytes = body.bytes()

                if (bytes.isEmpty()) {
                    return ApiResult.Failure(
                        message = "O arquivo veio vazio. Tente novamente.",
                        statusCode = response.code
                    )
                }

                ApiResult.Success(
                    DownloadedFile(
                        bytes = bytes,
                        contentType = contentType,
                        fileName = fileNameFromDisposition(response.header("Content-Disposition").orEmpty())
                            .ifBlank { fallbackFileName }
                    )
                )
            }
        } catch (error: IOException) {
            ApiResult.Failure(error.message ?: "Erro de rede")
        } catch (error: Exception) {
            ApiResult.Failure(error.message ?: "Erro inesperado")
        }
    }

    companion object {
        private const val TAG = "IA4TubeApiClient"
        private const val CREATE_ORDER_UNAVAILABLE_MESSAGE =
            "Não foi possível criar o pedido agora. Tente novamente em alguns instantes."
        private val JSON = "application/json; charset=utf-8".toMediaType()

        private fun logMultipart(url: String, fields: Iterable<String>, files: Iterable<br.com.ia4tube.app.data.models.UploadFile>) {
            val fieldNames = fields.distinct().joinToString(",")
            val fileInfo = files.joinToString(";") { file ->
                "${file.fileName}|${file.contentType}|${file.bytes.size} bytes"
            }
            Log.d(TAG, "Multipart url=$url fields=$fieldNames files=$fileInfo")
        }

        private fun adjustmentMessage(json: JSONObject): String {
            val explicitMessage = json.optString("message")
                .ifBlank { json.optString("mensagem") }
            if (explicitMessage.isNotBlank()) return explicitMessage

            val status = json.optString("status")
            val suporteId = json.optString("suporte_id")
                .ifBlank { json.optString("ticket_id") }
            val suporteAberto = json.optBoolean("suporte_aberto", false)

            return when {
                suporteId.isNotBlank() -> "Ajuste solicitado. Suporte: $suporteId."
                suporteAberto -> "Ajuste solicitado e suporte aberto."
                status.isNotBlank() -> "Ajuste solicitado. Status: $status."
                else -> "Ajuste solicitado com sucesso."
            }
        }

        private fun apiErrorMessage(text: String): String {
            if (text.isBlank()) return ""
            return try {
                val json = JSONObject(text)
                json.optString("error")
                    .ifBlank { json.optString("erro") }
                    .ifBlank { json.optString("message") }
                    .ifBlank { json.optString("mensagem") }
            } catch (_: Exception) {
                ""
            }
        }

        private fun paymentInfoFromJson(json: JSONObject): PaymentInfo {
            return PaymentInfo(
                pagamentoPendente = json.optBoolean("pagamento_pendente", true),
                valorPendente = json.optDouble("valor_pendente", 0.0),
                mpPaymentStatus = json.optString("mp_payment_status"),
                pixCopiaCola = json.optString("pix_copia_cola"),
                qrCodeBase64 = json.optString("qr_code_base64"),
                ticketUrl = json.optString("ticket_url"),
                paymentId = json.optString("payment_id")
            )
        }

        private fun billingPixFromJson(json: JSONObject): BillingPixResult {
            return BillingPixResult(
                pixCopiaCola = json.optString("pix_copia_cola"),
                qrCodeBase64 = json.optString("qr_code_base64"),
                ticketUrl = json.optString("ticket_url"),
                paymentId = json.optString("payment_id"),
                valorPago = json.optDouble("valor_pago", 0.0),
                credito = json.optDouble("credito", 0.0),
                planId = json.optString("plan_id"),
                planName = json.optString("plan_name"),
                artesMes = json.optInt("artes_mes", 0),
                purchaseId = json.optString("purchase_id"),
                tipo = json.optString("tipo"),
                produtoId = json.optString("produto_id"),
                quantidade = json.optInt("quantidade", 0)
            )
        }

        private fun companyGraphicMaterialsFromJson(json: JSONObject): CompanyGraphicMaterialsListResponse {
            val planJson = json.optJSONObject("plano") ?: JSONObject()
            val limitsJson = json.optJSONObject("limites") ?: JSONObject()
            val materialsJson = json.optJSONArray("materiais") ?: JSONArray()
            val materials = buildList {
                for (index in 0 until materialsJson.length()) {
                    val item = materialsJson.optJSONObject(index) ?: continue
                    add(companyGraphicMaterialFromJson(item))
                }
            }

            return CompanyGraphicMaterialsListResponse(
                ciclo = json.optString("ciclo"),
                plano = CompanyGraphicMaterialsPlan(
                    key = planJson.optString("key"),
                    nome = planJson.optString("nome"),
                    status = planJson.optString("status")
                ),
                limites = CompanyGraphicMaterialsLimits(
                    geral = limitsJson.optInt("geral", 0),
                    ramo = limitsJson.optInt("ramo", 0)
                ),
                materiais = materials
            )
        }

        private fun companyGraphicMaterialFromJson(item: JSONObject): CompanyGraphicMaterial {
            return CompanyGraphicMaterial(
                id = item.optString("id"),
                title = item.optString("title"),
                type = item.optString("type"),
                scope = item.optString("scope"),
                format = item.optString("format", "png"),
                width = item.optInt("width", 1240),
                height = item.optInt("height", 1754),
                status = item.optString("status"),
                statusLabel = item.optString("status_label"),
                createdInCycle = item.optBoolean("created_in_cycle", false),
                createdAt = item.optString("created_at"),
                documentId = item.optString("document_id"),
                ready = item.optBoolean("ready", false),
                downloadUrl = item.optString("download_url"),
                locked = item.optBoolean("locked", false),
                planRequired = item.optString("plan_required")
            )
        }

        private fun carouselStatusFromJson(item: JSONObject): CarouselStatus {
            return CarouselStatus(
                id = item.optString("id"),
                carrosselId = item.optString("carrossel_id").ifBlank { item.optString("id") },
                tema = item.optString("tema"),
                quantidadeTelas = item.optInt("quantidade_telas", 0),
                nivelConteudo = item.optInt("nivel_conteudo", 2).coerceIn(1, 3),
                status = item.optString("status"),
                statusLabel = item.optString("status_label"),
                ready = item.optBoolean("ready", false),
                ciclo = item.optString("ciclo"),
                criadoEm = item.optString("criado_em"),
                atualizadoEm = item.optString("atualizado_em"),
                descricaoInstagram = item.optString("descricao_instagram"),
                downloadUrl = item.optString("download_url")
            )
        }

        private fun monthlyPlanningPhotoOrientationsJson(requestData: MonthlyPlanningRequest): String {
            val array = JSONArray()
            requestData.fotos.forEachIndexed { index, photo ->
                array.put(
                    JSONObject()
                        .put("ordem", index + 1)
                        .put("arquivo", photo.file.fileName)
                        .put("orientacao", photo.orientacao.trim())
                )
            }
            return array.toString()
        }

        private fun monthlyPlanningSummaryFromJson(item: JSONObject): MonthlyPlanningSummaryDto {
            val total = item.optInt("total_postagens", item.optInt("quantidade_reservada", 0))
            val ready = item.optInt("prontas", item.optInt("ja_produzidas", 0))
            return MonthlyPlanningSummaryDto(
                id = item.optString("planejamento_id").ifBlank { item.optString("id") },
                title = item.optString("titulo").ifBlank { "Planejamento Mensal" },
                status = item.optString("status_label").ifBlank { item.optString("status") },
                cycle = item.optString("ciclo"),
                totalPosts = total,
                readyPosts = ready,
                productionPosts = item.optInt("em_producao", 0),
                plannedPosts = item.optInt("planejadas", 0),
                errorPosts = item.optInt("erros", 0)
            )
        }

        private fun monthlyPlanningPostFromJson(item: JSONObject, fallbackNumber: Int): MonthlyPlanningPostDto {
            return MonthlyPlanningPostDto(
                number = item.optInt("ordem", fallbackNumber),
                itemId = item.optString("planejamento_item_id").ifBlank { item.optString("id") },
                date = item.optString("data_sugerida"),
                time = item.optString("horario_sugerido"),
                theme = item.optString("tema"),
                objective = item.optString("objetivo").ifBlank { item.optString("objetivo_postagem") },
                status = item.optString("status"),
                statusLabel = item.optString("status_label").ifBlank { item.optString("status") },
                caption = item.optString("legenda").ifBlank { item.optString("briefing_arte") },
                pedidoId = item.optString("pedido_id"),
                imageReady = item.optBoolean("imagem_pronta", false)
            )
        }

        private fun fileNameFromDisposition(disposition: String): String {
            if (disposition.isBlank()) return ""
            val marker = "filename="
            val index = disposition.indexOf(marker, ignoreCase = true)
            if (index < 0) return ""
            return disposition
                .substring(index + marker.length)
                .trim()
                .trim('"')
                .substringBefore(";")
                .trim()
        }

        private fun createArteEmpresaFieldsJson(requestData: CreateArtEmpresaRequest): JSONObject {
            return JSONObject()
                .put("ramo", requestData.ramo)
                .put("ramo_origem", "manual")
                .put("nome_empresa", requestData.nomeEmpresa)
                .put("objetivo", requestData.objetivo)
                .put("objetivo_origem", "manual")
                .put("estilo_visual_cliente", requestData.estiloVisualCliente)
                .put("oferta", requestData.oferta)
                .put("cta", requestData.cta)
                .put("whatsapp", requestData.whatsapp)
                .put("instagram", requestData.instagram)
                .put("observacoes", requestData.observacoes)
                .put("frase_foto", requestData.fraseFoto)
                .put("historia_empresa", requestData.historiaEmpresa)
                .put("origem_foto_rapida", requestData.origemFotoRapida)
                .put("usar_modelo_existente", requestData.modeloExistente != null)
                .put("campos_dinamicos", JSONObject(requestData.camposDinamicos))
        }

        private fun filesArray(files: List<br.com.ia4tube.app.data.models.UploadFile>): JSONArray {
            val array = JSONArray()
            files.forEach { file -> array.put(file.fileName) }
            return array
        }

        private fun jsonValue(value: Any): Any {
            return when (value) {
                is Map<*, *> -> JSONObject(value)
                is Iterable<*> -> JSONArray(value.map { item -> if (item is Map<*, *>) JSONObject(item) else item })
                is Array<*> -> JSONArray(value.map { item -> if (item is Map<*, *>) JSONObject(item) else item })
                else -> value
            }
        }

        private fun supportSenderFromJson(item: JSONObject): SupportSender {
            val raw = item.optString("autor")
                .ifBlank { item.optString("remetente") }
                .ifBlank { item.optString("tipo") }
                .ifBlank { item.optString("origem") }
                .lowercase()

            return if (
                raw.contains("cliente") ||
                raw.contains("user") ||
                raw.contains("usuario") ||
                raw.contains("usuário")
            ) {
                SupportSender.Client
            } else {
                SupportSender.Support
            }
        }

        private fun JSONObject.optionalInt(name: String): Int? {
            return if (has(name) && !isNull(name)) optInt(name) else null
        }

        private fun JSONObject.optionalString(name: String): String? {
            return if (has(name) && !isNull(name)) optString(name) else null
        }

        private fun defaultClient(): OkHttpClient {
            return OkHttpClient.Builder()
                .connectTimeout(20, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .build()
        }
    }
}
