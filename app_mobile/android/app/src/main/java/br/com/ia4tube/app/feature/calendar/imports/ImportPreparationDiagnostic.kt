package br.com.ia4tube.app.feature.calendar.imports

/** Only fixed labels may reach the screen: never interpolate HTTP bodies, URLs or credentials. */
internal fun importPreparationDiagnostic(stage: ImportPreparationDiagnosticStage?, code: String): String {
    val step = when (stage) {
        ImportPreparationDiagnosticStage.LOCAL_STATE -> "rascunho salvo"
        ImportPreparationDiagnosticStage.CAPABILITIES -> "disponibilidade da importação"
        ImportPreparationDiagnosticStage.STATUS -> "consulta do arquivo preparado"
        ImportPreparationDiagnosticStage.METADATA -> "conferência da versão do arquivo"
        ImportPreparationDiagnosticStage.PREVIEW -> "consulta da prévia"
        ImportPreparationDiagnosticStage.SCHEDULING_AVAILABILITY -> "disponibilidade do calendário"
        null -> "preparação ou agendamento"
    }
    val reference = when (code) {
        "import_response_invalid" -> "P01"
        "import_network_unavailable" -> "P02"
        "import_preparation_unavailable", "import_owner_unavailable" -> "P03"
        "import_preparation_identity_invalid" -> "P04"
        "import_preparation_revision_changed" -> "P05"
        "import_preparation_source_changed" -> "P06"
        "import_preparation_duration_changed" -> "P07"
        "import_preparation_preview_invalid" -> "P08"
        "import_schedule_availability_invalid" -> "P09"
        "import_preparation_prepared_changed" -> "P10"
        "import_preparation_transition_invalid" -> "P11"
        "import_preparation_invalid_result" -> "P12"
        "checkpoint_conflict" -> "P13"
        else -> "P00"
    }
    return "Não foi possível concluir: $step. Referência $reference. O rascunho foi mantido; não envie outro arquivo para tentar corrigir."
}
