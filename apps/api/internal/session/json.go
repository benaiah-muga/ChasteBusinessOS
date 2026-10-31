package session

import "encoding/json"

// decodeStringArray reads a jsonb text array. Organizations store
// enabled_modules as either NULL (every standard module) or a json array, and
// a malformed value must fail closed rather than silently reading as "all
// modules enabled", which would widen access.
func decodeStringArray(raw []byte, out *[]string) error {
	var values []string
	if err := json.Unmarshal(raw, &values); err != nil {
		return err
	}
	*out = values
	return nil
}
