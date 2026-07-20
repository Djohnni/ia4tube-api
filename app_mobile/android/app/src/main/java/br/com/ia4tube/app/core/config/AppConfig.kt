package br.com.ia4tube.app.core.config

import br.com.ia4tube.app.BuildConfig

object AppConfig {
    val apiBase: String = BuildConfig.API_BASE.trimEnd('/')
    val productDiscoveryApiBase: String = BuildConfig.PRODUCT_DISCOVERY_API_BASE.trimEnd('/')
}
