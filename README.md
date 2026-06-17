# billing-service
Open Source Billing Service

## Credit balance fields

`balance_cents` is spendable availability: credited funds minus actualized usage and provisioned holds. Keep using it for authorization, depletion, runway, and top-up safety checks.

`actual_balance_cents` is the user-facing credit balance: credited funds minus actualized usage only. Provisioned holds are excluded because they may later actualize or cancel.
