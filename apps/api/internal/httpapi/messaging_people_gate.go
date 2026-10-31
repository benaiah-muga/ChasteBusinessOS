package httpapi

// MessagingPeopleDisabledCapabilities disables the direct people lookup only
// when the API rollout flag is explicitly turned off.
func MessagingPeopleDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"messaging.listPeople": {}}
}
