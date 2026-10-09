package httpapi

func PurchasingAPAgingDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"purchasing.apAging": {}}
}
