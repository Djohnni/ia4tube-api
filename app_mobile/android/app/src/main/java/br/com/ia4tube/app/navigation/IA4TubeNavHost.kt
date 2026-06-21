package br.com.ia4tube.app.navigation

import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.NavType
import androidx.navigation.navArgument
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import br.com.ia4tube.app.core.download.ImageDownloadStore
import br.com.ia4tube.app.core.download.ZipDownloadStore
import br.com.ia4tube.app.core.company.CompanyProfileStore
import br.com.ia4tube.app.core.notifications.FcmTokenRegistrar
import br.com.ia4tube.app.core.notifications.NotificationNavigationTarget
import br.com.ia4tube.app.core.session.SessionStore
import br.com.ia4tube.app.core.analytics.MobileAnalytics
import br.com.ia4tube.app.core.analytics.MobileAnalyticsTracker
import br.com.ia4tube.app.data.api.IA4TubeApiClient
import br.com.ia4tube.app.data.repository.AuthRepository
import br.com.ia4tube.app.data.repository.CarouselRepository
import br.com.ia4tube.app.data.repository.CompanyGraphicMaterialsRepository
import br.com.ia4tube.app.domain.usecase.ApproveOrderUseCase
import br.com.ia4tube.app.domain.usecase.CheckCarouselStatusUseCase
import br.com.ia4tube.app.domain.usecase.CheckCompanyGraphicMaterialStatusUseCase
import br.com.ia4tube.app.domain.usecase.CreateArtEmpresaUseCase
import br.com.ia4tube.app.domain.usecase.DownloadCarouselUseCase
import br.com.ia4tube.app.domain.usecase.DownloadCompanyGraphicMaterialUseCase
import br.com.ia4tube.app.domain.usecase.DownloadOrderResultUseCase
import br.com.ia4tube.app.domain.usecase.GenerateCompanyGraphicMaterialUseCase
import br.com.ia4tube.app.domain.usecase.GeneratePixUseCase
import br.com.ia4tube.app.domain.usecase.LoadMeUseCase
import br.com.ia4tube.app.domain.usecase.LoadOrderInfoUseCase
import br.com.ia4tube.app.domain.usecase.LoadPaymentInfoUseCase
import br.com.ia4tube.app.domain.usecase.ListCarouselsUseCase
import br.com.ia4tube.app.domain.usecase.ListCompanyGraphicMaterialsUseCase
import br.com.ia4tube.app.domain.usecase.ListOrdersUseCase
import br.com.ia4tube.app.domain.usecase.ListSupportMessagesUseCase
import br.com.ia4tube.app.domain.usecase.LoginUseCase
import br.com.ia4tube.app.domain.usecase.PayOrderWithBalanceUseCase
import br.com.ia4tube.app.domain.usecase.RequestCarouselUseCase
import br.com.ia4tube.app.domain.usecase.RequestOrderAdjustmentUseCase
import br.com.ia4tube.app.domain.usecase.RegisterUseCase
import br.com.ia4tube.app.domain.usecase.SendSupportMessageUseCase
import br.com.ia4tube.app.feature.carousel.CarouselScreen
import br.com.ia4tube.app.feature.carousel.CarouselViewModel
import br.com.ia4tube.app.feature.carousel.CarouselViewModelFactory
import br.com.ia4tube.app.feature.create_art.CreateArtEmpresaScreen
import br.com.ia4tube.app.feature.create_art.CreateArtEmpresaViewModel
import br.com.ia4tube.app.feature.create_art.CreateArtEmpresaViewModelFactory
import br.com.ia4tube.app.feature.company_profile.CompanyProfileScreen
import br.com.ia4tube.app.feature.company_profile.CompanyGraphicMaterialsViewModel
import br.com.ia4tube.app.feature.company_profile.CompanyGraphicMaterialsViewModelFactory
import br.com.ia4tube.app.feature.company_profile.CompanyProfileViewModel
import br.com.ia4tube.app.feature.company_profile.CompanyProfileViewModelFactory
import br.com.ia4tube.app.feature.auth.AuthRequiredSheet
import br.com.ia4tube.app.feature.auth.LoginScreen
import br.com.ia4tube.app.feature.auth.LoginViewModel
import br.com.ia4tube.app.feature.auth.LoginViewModelFactory
import br.com.ia4tube.app.feature.auth.RegisterScreen
import br.com.ia4tube.app.feature.auth.RegisterViewModel
import br.com.ia4tube.app.feature.auth.RegisterViewModelFactory
import br.com.ia4tube.app.feature.home.HomeScreen
import br.com.ia4tube.app.feature.home.PremiumHomePalette
import br.com.ia4tube.app.feature.home.PremiumHomeTheme
import br.com.ia4tube.app.feature.home.HomeViewModel
import br.com.ia4tube.app.feature.home.HomeViewModelFactory
import br.com.ia4tube.app.feature.home.premiumHomePalette
import br.com.ia4tube.app.feature.monthly_planning.MonthlyPlanningDetailScreen
import br.com.ia4tube.app.feature.monthly_planning.MonthlyPlanningScreen
import br.com.ia4tube.app.feature.monthly_planning.MonthlyPlanningViewModel
import br.com.ia4tube.app.feature.monthly_planning.MonthlyPlanningViewModelFactory
import br.com.ia4tube.app.feature.orders.OrderDetailScreen
import br.com.ia4tube.app.feature.orders.OrderDetailViewModel
import br.com.ia4tube.app.feature.orders.OrderDetailViewModelFactory
import br.com.ia4tube.app.feature.orders.OrderListFilter
import br.com.ia4tube.app.feature.orders.OrdersScreen
import br.com.ia4tube.app.feature.orders.OrdersViewModel
import br.com.ia4tube.app.feature.orders.OrdersViewModelFactory
import br.com.ia4tube.app.feature.plans.PlansScreen
import br.com.ia4tube.app.feature.plans.PlansViewModel
import br.com.ia4tube.app.feature.plans.PlansViewModelFactory
import br.com.ia4tube.app.feature.splash.SplashScreen
import br.com.ia4tube.app.feature.splash.SplashViewModel
import br.com.ia4tube.app.feature.splash.SplashViewModelFactory
import br.com.ia4tube.app.feature.support.SupportScreen
import br.com.ia4tube.app.feature.support.SupportViewModel
import br.com.ia4tube.app.feature.support.SupportViewModelFactory

@Composable
fun IA4TubeNavHost(
    notificationTarget: NotificationNavigationTarget? = null,
    onNotificationTargetHandled: () -> Unit = {}
) {
    val navController = rememberNavController()
    val backStackEntry = navController.currentBackStackEntryAsState()
    val currentRoute = backStackEntry.value?.destination?.route
    var premiumHomeThemeName by rememberSaveable { mutableStateOf(PremiumHomeTheme.Black.name) }
    val premiumHomeTheme = PremiumHomeTheme.valueOf(premiumHomeThemeName)
    val premiumPalette = premiumHomePalette(premiumHomeTheme)
    val usePremiumShell = shouldUsePremiumShell(currentRoute)
    val context = LocalContext.current.applicationContext
    val apiClient = remember {
        IA4TubeApiClient()
    }
    val sessionStore = remember {
        SessionStore(context)
    }
    val fcmTokenRegistrar = remember {
        FcmTokenRegistrar(
            context = context,
            apiClient = apiClient,
            sessionStore = sessionStore
        )
    }
    val repository = remember {
        AuthRepository(
            apiClient = apiClient,
            sessionStore = sessionStore,
            fcmTokenRegistrar = fcmTokenRegistrar
        )
    }
    val graphicMaterialsRepository = remember {
        CompanyGraphicMaterialsRepository(
            apiClient = apiClient,
            sessionStore = sessionStore
        )
    }
    val carouselRepository = remember {
        CarouselRepository(
            apiClient = apiClient,
            sessionStore = sessionStore
        )
    }
    val imageDownloadStore = remember {
        ImageDownloadStore(context)
    }
    val zipDownloadStore = remember {
        ZipDownloadStore(context)
    }
    val companyProfileStore = remember {
        CompanyProfileStore(context)
    }
    val analyticsTracker = remember {
        MobileAnalyticsTracker(
            context = context,
            tokenProvider = repository::getSavedToken
        )
    }
    var pendingProtectedRoute by rememberSaveable { mutableStateOf<String?>(null) }
    var cameraRequestKey by rememberSaveable { mutableStateOf(0) }
    var showAuthSheet by rememberSaveable { mutableStateOf(false) }

    fun hasSavedToken(): Boolean = repository.getSavedToken().isNotBlank()

    fun routeForNotification(target: NotificationNavigationTarget): String {
        if (target.pedidoId.isNotBlank()) return Routes.orderDetail(target.pedidoId)
        if (target.planejamentoId.isNotBlank()) return Routes.monthlyPlanningDetail(target.planejamentoId)

        val type = target.tipo.lowercase()
        val route = target.route.lowercase()

        return when {
            type == "arte_pronta" || type == "pedido_atualizado" -> Routes.orders(OrderListFilter.All)
            type == "planejamento_mensal" || route.contains("monthly_planning") -> Routes.MonthlyPlanning
            type == "nova_versao" || type == "aviso_geral" -> Routes.Home
            route.contains("orders") || route.contains("pedidos") -> Routes.orders(OrderListFilter.All)
            route.contains("planning") || route.contains("planejamento") -> Routes.MonthlyPlanning
            route.contains("plans") || route.contains("planos") -> Routes.Plans
            else -> Routes.Home
        }
    }

    fun isProtectedNotificationRoute(route: String): Boolean {
        return route != Routes.Home && route != Routes.Splash && route != Routes.Login && route != Routes.Register
    }

    fun requestAuthFor(route: String) {
        pendingProtectedRoute = route
        showAuthSheet = true
        if (currentRoute != Routes.Home) {
            navController.navigate(Routes.Home) {
                launchSingleTop = true
            }
        }
    }

    fun dismissAuthSheet() {
        showAuthSheet = false
        pendingProtectedRoute = null
    }

    fun openLoginScreen() {
        showAuthSheet = false
        navController.navigate(Routes.Login) {
            launchSingleTop = true
        }
    }

    fun openRegisterScreen() {
        showAuthSheet = false
        navController.navigate(Routes.Register) {
            launchSingleTop = true
        }
    }

    fun navigateProtected(route: String) {
        if (hasSavedToken()) {
            navController.navigate(route)
        } else {
            requestAuthFor(route)
        }
    }

    fun continueAfterAuth() {
        val target = pendingProtectedRoute
        pendingProtectedRoute = null

        when (target) {
            PENDING_CAMERA_ACTION -> {
                cameraRequestKey += 1
                navController.navigate(Routes.Home) {
                    popUpTo(Routes.Home) { inclusive = false }
                    launchSingleTop = true
                }
            }
            Routes.createArtEmpresa() -> {
                navController.navigate(Routes.Home) {
                    popUpTo(Routes.Home) { inclusive = false }
                    launchSingleTop = true
                }
            }
            null -> {
                navController.navigate(Routes.Home) {
                    popUpTo(Routes.Login) { inclusive = true }
                    launchSingleTop = true
                }
            }
            else -> {
                navController.navigate(target) {
                    popUpTo(Routes.Home) { inclusive = false }
                    launchSingleTop = true
                }
            }
        }
    }

    fun finishAuthSheet() {
        showAuthSheet = false
        continueAfterAuth()
    }

    LaunchedEffect(Unit) {
        MobileAnalytics.init(analyticsTracker)
    }

    LaunchedEffect(hasSavedToken()) {
        if (hasSavedToken()) {
            fcmTokenRegistrar.syncCurrentToken()
        }
    }

    LaunchedEffect(notificationTarget?.nonce) {
        val target = notificationTarget ?: return@LaunchedEffect
        val route = routeForNotification(target)

        if (isProtectedNotificationRoute(route) && !hasSavedToken()) {
            requestAuthFor(route)
        } else {
            navController.navigate(route) {
                launchSingleTop = true
                if (route == Routes.Home) {
                    popUpTo(Routes.Home) { inclusive = false }
                }
            }
        }

        onNotificationTargetHandled()
    }

    MaterialTheme(
        colorScheme = if (usePremiumShell) {
            premiumPalette.toAppColorScheme(MaterialTheme.colorScheme)
        } else {
            MaterialTheme.colorScheme
        }
    ) {
        Scaffold(
            containerColor = MaterialTheme.colorScheme.background
        ) { innerPadding ->
            NavHost(
                navController = navController,
                startDestination = Routes.Splash,
                modifier = Modifier.padding(innerPadding)
            ) {
        composable(Routes.Splash) {
            val viewModel: SplashViewModel = viewModel(
                factory = SplashViewModelFactory(repository, LoadMeUseCase(repository))
            )
            SplashScreen(
                viewModel = viewModel,
                onGoLogin = {
                    navController.navigate(Routes.Login) {
                        popUpTo(Routes.Splash) { inclusive = true }
                    }
                },
                onGoHome = {
                    navController.navigate(Routes.Home) {
                        popUpTo(Routes.Splash) { inclusive = true }
                    }
                }
            )
        }

        composable(Routes.Login) {
            LaunchedEffect(Unit) {
                MobileAnalytics.track("mobile_login_abriu", tela = "login")
            }
            val viewModel: LoginViewModel = viewModel(
                factory = LoginViewModelFactory(LoginUseCase(repository))
            )
            LoginScreen(
                viewModel = viewModel,
                onLoggedIn = ::continueAfterAuth
            )
        }

        composable(Routes.Register) {
            val viewModel: RegisterViewModel = viewModel(
                factory = RegisterViewModelFactory(RegisterUseCase(repository))
            )
            RegisterScreen(
                viewModel = viewModel,
                onRegisteredIn = ::continueAfterAuth,
                onBack = { navController.popBackStack() }
            )
        }

        composable(Routes.Home) {
            LaunchedEffect(Unit) {
                MobileAnalytics.track("mobile_home_abriu", tela = "home")
            }
            val viewModel: HomeViewModel = viewModel(
                factory = HomeViewModelFactory(
                    repository,
                    LoadMeUseCase(repository),
                    ListOrdersUseCase(repository)
                )
            )
            LaunchedEffect(viewModel) {
                viewModel.refresh()
            }
            HomeScreen(
                viewModel = viewModel,
                onOpenOrders = { filter ->
                    MobileAnalytics.track("mobile_meus_pedidos_abriu", tela = "home", payload = mapOf("filtro" to filter.routeValue))
                    navigateProtected(Routes.orders(filter))
                },
                onCreateArtEmpresa = {
                    MobileAnalytics.track("mobile_criar_arte_abriu", tela = "home", produto = "arte_empresa")
                    navigateProtected(Routes.createArtEmpresa())
                },
                onCreateArtFromPhoto = { photoUri ->
                    MobileAnalytics.track("mobile_criar_arte_camera_abriu", tela = "home", produto = "arte_empresa")
                    navigateProtected(Routes.createArtEmpresa(photoUri))
                },
                onOpenCarousel = {
                    MobileAnalytics.track("mobile_carrossel_abriu", tela = "home", produto = "carrossel")
                    navigateProtected(Routes.Carousel)
                },
                onOpenMonthlyPlanning = {
                    MobileAnalytics.track("mobile_planejamento_mensal_abriu", tela = "home", produto = "planejamento_mensal")
                    navigateProtected(Routes.MonthlyPlanning)
                },
                onOpenPlans = {
                    MobileAnalytics.track("mobile_planos_abriu", tela = "home")
                    navigateProtected(Routes.Plans)
                },
                onCompanyProfile = {
                    MobileAnalytics.track("mobile_perfil_empresa_abriu", tela = "home")
                    navController.navigate(Routes.CompanyProfile)
                },
                onSupport = {
                    MobileAnalytics.track("mobile_suporte_abriu", tela = "home")
                    navigateProtected(Routes.Support)
                },
                premiumTheme = premiumHomeTheme,
                onPremiumThemeSelected = { premiumHomeThemeName = it.name },
                onLogout = {
                    pendingProtectedRoute = null
                    repository.logout()
                    navController.navigate(Routes.Login) {
                        popUpTo(Routes.Home) { inclusive = true }
                    }
                },
                isLoggedIn = hasSavedToken(),
                cameraRequestKey = cameraRequestKey,
                onCameraAuthRequired = {
                    requestAuthFor(PENDING_CAMERA_ACTION)
                }
            )
        }

        composable(Routes.Carousel) {
            if (!hasSavedToken()) {
                LaunchedEffect(Unit) {
                    requestAuthFor(Routes.Carousel)
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track("mobile_carrossel_abriu", tela = "carrossel", produto = "carrossel")
                }
                val viewModel: CarouselViewModel = viewModel(
                    factory = CarouselViewModelFactory(
                        requestCarousel = RequestCarouselUseCase(carouselRepository),
                        listCarousels = ListCarouselsUseCase(carouselRepository),
                        checkCarouselStatus = CheckCarouselStatusUseCase(carouselRepository),
                        downloadCarousel = DownloadCarouselUseCase(
                            carouselRepository,
                            zipDownloadStore
                        ),
                        loadMe = LoadMeUseCase(repository)
                    )
                )
                CarouselScreen(
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() }
                )
            }
        }

        composable(Routes.MonthlyPlanning) {
            if (!hasSavedToken()) {
                LaunchedEffect(Unit) {
                    requestAuthFor(Routes.MonthlyPlanning)
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track(
                        "mobile_planejamento_mensal_abriu",
                        tela = "planejamento_mensal",
                        produto = "planejamento_mensal"
                    )
                }
                val viewModel: MonthlyPlanningViewModel = viewModel(
                    factory = MonthlyPlanningViewModelFactory(repository, companyProfileStore)
                )
                MonthlyPlanningScreen(
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() },
                    onOpenDetail = { planningId ->
                        navController.navigate(Routes.monthlyPlanningDetail(planningId))
                    }
                )
            }
        }

        composable(
            route = Routes.MonthlyPlanningDetail,
            arguments = listOf(
                navArgument("planningId") {
                    type = NavType.StringType
                }
            )
        ) { backStackEntry ->
            val planningId = backStackEntry.arguments?.getString("planningId").orEmpty()
            if (!hasSavedToken()) {
                LaunchedEffect(planningId) {
                    requestAuthFor(Routes.monthlyPlanningDetail(planningId))
                }
            } else {
                val viewModel: MonthlyPlanningViewModel = viewModel(
                    factory = MonthlyPlanningViewModelFactory(repository, companyProfileStore)
                )
                MonthlyPlanningDetailScreen(
                    planningId = planningId,
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() },
                    onOpenOrder = { pedidoId ->
                        navigateProtected(Routes.orderDetail(pedidoId))
                    }
                )
            }
        }

        composable(
            route = Routes.CreateArtEmpresa,
            arguments = listOf(
                navArgument("photoUri") {
                    type = NavType.StringType
                    defaultValue = ""
                    nullable = true
                }
            )
        ) { backStackEntry ->
            val photoUri = backStackEntry.arguments?.getString("photoUri").orEmpty()
            if (!hasSavedToken()) {
                LaunchedEffect(photoUri) {
                    requestAuthFor(Routes.createArtEmpresa(photoUri))
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track("mobile_criar_arte_abriu", tela = "criar_arte", produto = "arte_empresa")
                }
                val viewModel: CreateArtEmpresaViewModel = viewModel(
                    factory = CreateArtEmpresaViewModelFactory(
                        createArtEmpresa = CreateArtEmpresaUseCase(repository),
                        companyProfileStore = companyProfileStore
                    )
                )
                CreateArtEmpresaScreen(
                    viewModel = viewModel,
                    initialPhotoUri = photoUri,
                    onBack = { navController.popBackStack() },
                    onOpenPlans = {
                        MobileAnalytics.track("mobile_planos_abriu", tela = "criar_arte")
                        navigateProtected(Routes.Plans)
                    },
                    onCreated = { pedidoId ->
                        navController.navigate(Routes.orderDetail(pedidoId)) {
                            popUpTo(Routes.CreateArtEmpresa) { inclusive = true }
                        }
                    }
                )
            }
        }

        composable(Routes.CompanyProfile) {
            LaunchedEffect(Unit) {
                MobileAnalytics.track("mobile_perfil_empresa_abriu", tela = "perfil_empresa")
            }
            val viewModel: CompanyProfileViewModel = viewModel(
                factory = CompanyProfileViewModelFactory(companyProfileStore)
            )
            val graphicMaterialsViewModel: CompanyGraphicMaterialsViewModel = viewModel(
                factory = CompanyGraphicMaterialsViewModelFactory(
                    listCompanyGraphicMaterials = ListCompanyGraphicMaterialsUseCase(graphicMaterialsRepository),
                    generateCompanyGraphicMaterial = GenerateCompanyGraphicMaterialUseCase(graphicMaterialsRepository),
                    checkCompanyGraphicMaterialStatus = CheckCompanyGraphicMaterialStatusUseCase(graphicMaterialsRepository),
                    downloadCompanyGraphicMaterial = DownloadCompanyGraphicMaterialUseCase(
                        graphicMaterialsRepository,
                        imageDownloadStore
                    )
                )
            )
            CompanyProfileScreen(
                viewModel = viewModel,
                graphicMaterialsViewModel = graphicMaterialsViewModel,
                isLoggedIn = hasSavedToken(),
                onProfileSaved = {
                    navController.navigate(Routes.Home) {
                        popUpTo(Routes.CompanyProfile) { inclusive = true }
                        launchSingleTop = true
                    }
                },
                onAuthRequired = {
                    pendingProtectedRoute = Routes.CompanyProfile
                    showAuthSheet = true
                },
                onLogout = {
                    pendingProtectedRoute = null
                    repository.logout()
                    navController.navigate(Routes.Login) {
                        popUpTo(Routes.Home) { inclusive = true }
                        launchSingleTop = true
                    }
                }
            )
        }

        composable(Routes.Support) {
            if (!hasSavedToken()) {
                LaunchedEffect(Unit) {
                    requestAuthFor(Routes.Support)
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track("mobile_suporte_abriu", tela = "suporte")
                }
                val viewModel: SupportViewModel = viewModel(
                    factory = SupportViewModelFactory(
                        listSupportMessages = ListSupportMessagesUseCase(repository),
                        sendSupportMessage = SendSupportMessageUseCase(repository)
                    )
                )
                SupportScreen(
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() }
                )
            }
        }

        composable(Routes.Plans) {
            if (!hasSavedToken()) {
                LaunchedEffect(Unit) {
                    requestAuthFor(Routes.Plans)
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track("mobile_planos_abriu", tela = "planos")
                }
                val viewModel: PlansViewModel = viewModel(
                    factory = PlansViewModelFactory(repository)
                )
                PlansScreen(
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() }
                )
            }
        }

        composable(
            route = Routes.Orders,
            arguments = listOf(
                navArgument("filter") {
                    type = NavType.StringType
                    defaultValue = OrderListFilter.All.routeValue
                }
            )
        ) { backStackEntry ->
            val initialFilter = OrderListFilter.fromRoute(backStackEntry.arguments?.getString("filter"))
            if (!hasSavedToken()) {
                LaunchedEffect(initialFilter) {
                    requestAuthFor(Routes.orders(initialFilter))
                }
            } else {
                LaunchedEffect(Unit) {
                    MobileAnalytics.track("mobile_meus_pedidos_abriu", tela = "meus_pedidos")
                }
                val viewModel: OrdersViewModel = viewModel(
                    factory = OrdersViewModelFactory(ListOrdersUseCase(repository))
                )
                OrdersScreen(
                    viewModel = viewModel,
                    initialFilter = initialFilter,
                    onBack = { navController.popBackStack() },
                    onOpenOrder = { pedidoId ->
                        navigateProtected(Routes.orderDetail(pedidoId))
                    },
                    onOpenMonthlyPlanning = { planningId ->
                        navigateProtected(Routes.monthlyPlanningDetail(planningId))
                    }
                )
            }
        }

        composable(Routes.OrderDetail) { backStackEntry ->
            val pedidoId = backStackEntry.arguments?.getString("pedidoId").orEmpty()
            if (!hasSavedToken()) {
                LaunchedEffect(pedidoId) {
                    requestAuthFor(Routes.orderDetail(pedidoId))
                }
            } else {
                LaunchedEffect(pedidoId) {
                    MobileAnalytics.track(
                        "mobile_detalhe_pedido_abriu",
                        tela = "detalhe_pedido",
                        pedidoId = pedidoId
                    )
                }
                val viewModel: OrderDetailViewModel = viewModel(
                    factory = OrderDetailViewModelFactory(
                        pedidoId = pedidoId,
                        previewToken = repository.getSavedToken(),
                        loadOrderInfo = LoadOrderInfoUseCase(repository),
                        approveOrder = ApproveOrderUseCase(repository),
                        downloadOrderResult = DownloadOrderResultUseCase(repository, imageDownloadStore),
                        requestOrderAdjustment = RequestOrderAdjustmentUseCase(repository),
                        loadPaymentInfo = LoadPaymentInfoUseCase(repository),
                        generatePix = GeneratePixUseCase(repository),
                        payOrderWithBalance = PayOrderWithBalanceUseCase(repository)
                    )
                )
                OrderDetailScreen(
                    viewModel = viewModel,
                    onBack = { navController.popBackStack() }
                )
            }
            }
        }

            if (showAuthSheet) {
                AuthRequiredSheet(
                    onDismiss = ::dismissAuthSheet,
                    onLogin = { login, senha -> repository.login(login, senha) },
                    onRegister = { whatsapp, senha -> repository.register(whatsapp, senha) },
                    onAuthenticated = ::finishAuthSheet
                )
            }
    }
}

}

private fun shouldUsePremiumShell(route: String?): Boolean {
    return route != null &&
        route != Routes.Splash &&
        route != Routes.Login &&
        route != Routes.Register &&
        route != Routes.AuthRequired
}

private const val PENDING_CAMERA_ACTION = "__camera__"

private fun PremiumHomePalette.toAppColorScheme(base: ColorScheme): ColorScheme {
    val accent = when (screenBackground) {
        Color(0xFF020817) -> Color(0xFF2563EB)
        Color(0xFF17040F) -> Color(0xFFC02672)
        else -> Color(0xFFC9952E)
    }
    val premiumBackground = when (screenBackground) {
        Color(0xFFF8F4EA) -> Color(0xFFFBF7EF)
        Color(0xFF020817) -> Color(0xFFF3F7FF)
        Color(0xFF17040F) -> Color(0xFFFFF5FA)
        else -> Color(0xFFF7F3EA)
    }
    val cardSurface = when (screenBackground) {
        Color(0xFFF8F4EA) -> Color(0xFFFFFBF2)
        Color(0xFF020817) -> Color(0xFFEAF2FF)
        Color(0xFF17040F) -> Color(0xFFFFEAF4)
        else -> Color(0xFFFFF6DE)
    }
    val softSurface = when (screenBackground) {
        Color(0xFFF8F4EA) -> Color(0xFFF4E6C6)
        Color(0xFF020817) -> Color(0xFFD7E7FF)
        Color(0xFF17040F) -> Color(0xFFFFD6EA)
        else -> Color(0xFFF1DFC0)
    }
    val readableText = Color(0xFF111827)
    val mutedText = Color(0xFF4B5563)
    val outlineColor = accent.copy(alpha = 0.72f)

    return base.copy(
        primary = accent,
        onPrimary = Color(0xFF11100A),
        primaryContainer = softSurface,
        onPrimaryContainer = readableText,
        secondary = accent,
        onSecondary = Color(0xFF11100A),
        background = premiumBackground,
        onBackground = readableText,
        surface = cardSurface,
        onSurface = readableText,
        surfaceVariant = softSurface,
        onSurfaceVariant = mutedText,
        outline = outlineColor,
        outlineVariant = Color(0xFFD1D5DB)
    )
}
