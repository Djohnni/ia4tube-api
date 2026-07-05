package br.com.ia4tube.app.data.models

data class PaymentInfo(
    val pagamentoPendente: Boolean,
    val valorPendente: Double,
    val mpPaymentStatus: String,
    val pixCopiaCola: String,
    val qrCodeBase64: String,
    val ticketUrl: String,
    val paymentId: String
)

data class BalancePaymentResult(
    val message: String,
    val pagamentoPendente: Boolean
)

data class BillingPixResult(
    val pixCopiaCola: String,
    val qrCodeBase64: String,
    val ticketUrl: String,
    val paymentId: String,
    val valorPago: Double,
    val credito: Double = 0.0,
    val planId: String = "",
    val planName: String = "",
    val artesMes: Int = 0,
    val purchaseId: String = "",
    val tipo: String = "",
    val produtoId: String = "",
    val quantidade: Int = 0
)
