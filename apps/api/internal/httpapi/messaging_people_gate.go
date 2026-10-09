package httpapi

// MessagingPeopleDisabledCapabilities keeps the direct people lookup closed
// until the API rollout flag is explicitly enabled.
func MessagingPeopleDisabledCapabilities(enabled bool) map[string]struct{} {
	if enabled {
		return map[string]struct{}{}
	}
	return map[string]struct{}{"messaging.listPeople": {}}
}
