package capability

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/benaiah-muga/ChasteBusinessOS/apps/api/internal/authbridge"
	"github.com/jackc/pgx/v5"
)

// Capability ids for the documents module. Every handler in this file set is
// org-scoped: the executor supplies the transaction opened by
// dbx.WithOrgTx, so app.org_id is already set for PostgreSQL RLS.
const (
	documentsAddVersionCapabilityID        = "documents.addVersion"
	documentsCreateDocCapabilityID         = "documents.createDoc"
	documentsCreateDocumentCapabilityID    = "documents.createDocument"
	documentsCreateFolderCapabilityID      = "documents.createFolder"
	documentsCreateTemplateCapabilityID    = "documents.createTemplate"
	documentsDeleteDocCapabilityID         = "documents.deleteDoc"
	documentsDeleteDocumentCapabilityID    = "documents.deleteDocument"
	documentsDeleteFolderCapabilityID      = "documents.deleteFolder"
	documentsDeleteOrgMemoryCapabilityID   = "documents.deleteOrgMemory"
	documentsDeleteTemplateCapabilityID    = "documents.deleteTemplate"
	documentsGetDocCapabilityID            = "documents.getDoc"
	documentsGetTemplateCapabilityID       = "documents.getTemplate"
	documentsListDocumentsCapabilityID     = "documents.listDocuments"
	documentsListFoldersCapabilityID       = "documents.listFolders"
	documentsListTemplatesCapabilityID     = "documents.listTemplates"
	documentsListVersionsCapabilityID      = "documents.listVersions"
	documentsRenameFolderCapabilityID      = "documents.renameFolder"
	documentsRestoreDocVersionCapabilityID = "documents.restoreDocVersion"
	documentsSaveDocVersionCapabilityID    = "documents.saveDocVersion"
	documentsSearchMemoryCapabilityID      = "documents.searchMemory"
	documentsSearchRecordsCapabilityID     = "documents.searchRecords"
	documentsSuggestCodingCapabilityID     = "documents.suggestCoding"
	documentsUpdateDocMetadataCapabilityID = "documents.updateDocMetadata"
)

// DocumentsCapabilitySpecs returns the executor metadata for every documents
// capability, keyed by id, so the registry has a single wiring point.
func DocumentsCapabilitySpecs() map[string]capabilitySpec {
	return map[string]capabilitySpec{
		documentsAddVersionCapabilityID:        {module: "documents", permission: "documents.write", risk: "write"},
		documentsCreateDocCapabilityID:         {module: "documents", permission: "documents.write", risk: "write", inverseCapabilityID: documentsDeleteDocCapabilityID},
		documentsCreateDocumentCapabilityID:    {module: "documents", permission: "documents.write", risk: "write", inverseCapabilityID: documentsDeleteDocumentCapabilityID},
		documentsCreateFolderCapabilityID:      {module: "documents", permission: "documents.write", risk: "write", inverseCapabilityID: documentsDeleteFolderCapabilityID},
		documentsCreateTemplateCapabilityID:    {module: "documents", permission: "documents.write", risk: "write", inverseCapabilityID: documentsDeleteTemplateCapabilityID},
		documentsDeleteDocCapabilityID:         {module: "documents", permission: "documents.write", risk: "destructive"},
		documentsDeleteDocumentCapabilityID:    {module: "documents", permission: "documents.write", risk: "destructive"},
		documentsDeleteFolderCapabilityID:      {module: "documents", permission: "documents.write", risk: "destructive", inverseCapabilityID: documentsCreateFolderCapabilityID},
		documentsDeleteOrgMemoryCapabilityID:   {module: "documents", permission: "documents.write", risk: "destructive"},
		documentsDeleteTemplateCapabilityID:    {module: "documents", permission: "documents.write", risk: "destructive"},
		documentsGetDocCapabilityID:            {module: "documents", permission: "documents.read", risk: "read"},
		documentsGetTemplateCapabilityID:       {module: "documents", permission: "documents.read", risk: "read"},
		documentsParseDocumentCapabilityID:     {module: "documents", permission: "documents.write", risk: "write"},
		documentsListDocumentsCapabilityID:     {module: "documents", permission: "documents.read", risk: "read"},
		documentsListFoldersCapabilityID:       {module: "documents", permission: "documents.read", risk: "read"},
		documentsListTemplatesCapabilityID:     {module: "documents", permission: "documents.read", risk: "read"},
		documentsListVersionsCapabilityID:      {module: "documents", permission: "documents.read", risk: "read"},
		documentsRenameFolderCapabilityID:      {module: "documents", permission: "documents.write", risk: "write"},
		documentsRestoreDocVersionCapabilityID: {module: "documents", permission: "documents.write", risk: "write"},
		documentsSaveDocVersionCapabilityID:    {module: "documents", permission: "documents.write", risk: "write"},
		documentsSearchMemoryCapabilityID:      {module: "documents", permission: "documents.read", risk: "read"},
		documentsSearchRecordsCapabilityID:     {module: "documents", permission: "documents.read", risk: "read"},
		documentsSuggestCodingCapabilityID:     {module: "documents", permission: "documents.write", risk: "write"},
		documentsUpdateDocMetadataCapabilityID: {module: "documents", permission: "documents.write", risk: "write"},
	}
}

// DocumentsCapabilityIDs lists every documents capability id for the
// executor's supportedCapability switch.
func DocumentsCapabilityIDs() []string {
	return []string{
		documentsAddVersionCapabilityID,
		documentsCreateDocCapabilityID,
		documentsCreateDocumentCapabilityID,
		documentsCreateFolderCapabilityID,
		documentsCreateTemplateCapabilityID,
		documentsDeleteDocCapabilityID,
		documentsDeleteDocumentCapabilityID,
		documentsDeleteFolderCapabilityID,
		documentsDeleteOrgMemoryCapabilityID,
		documentsDeleteTemplateCapabilityID,
		documentsGetDocCapabilityID,
		documentsGetTemplateCapabilityID,
		documentsListDocumentsCapabilityID,
		documentsListFoldersCapabilityID,
		documentsListTemplatesCapabilityID,
		documentsListVersionsCapabilityID,
		documentsParseDocumentCapabilityID,
		documentsRenameFolderCapabilityID,
		documentsRestoreDocVersionCapabilityID,
		documentsSaveDocVersionCapabilityID,
		documentsSearchMemoryCapabilityID,
		documentsSearchRecordsCapabilityID,
		documentsSuggestCodingCapabilityID,
		documentsUpdateDocMetadataCapabilityID,
	}
}

// documentsPermissionFor answers permissionForCapability for this module.
func documentsPermissionFor(capabilityID string) (string, bool) {
	spec, ok := DocumentsCapabilitySpecs()[capabilityID]
	if !ok {
		return "", false
	}
	return spec.permission, true
}

// documentsRejection marks a business-rule refusal (a TS throw). The executor
// renders it as a 422 with the message, the same as the TypeScript kernel's
// failed receipt, instead of an opaque 500.
type documentsRejection struct{ message string }

func (e *documentsRejection) Error() string { return e.message }

func rejectDocuments(format string, args ...any) error {
	return &documentsRejection{message: fmt.Sprintf(format, args...)}
}

// DocumentsRejectionMessage reports whether err is a business-rule refusal and
// returns the message to surface to the caller.
func DocumentsRejectionMessage(err error) (string, bool) {
	var rejection *documentsRejection
	if errors.As(err, &rejection) {
		return rejection.message, true
	}
	return "", false
}

// documentsNullableString mirrors a Zod `string(...).nullable().optional()`
// field. The three states are load-bearing: an absent key leaves the stored
// column alone, an explicit null clears it, and a value replaces it. Keeping
// them distinguishable is also what lets the parsed input re-marshal to the
// exact bytes an approval stored, so re-parsing hashes identically.
type documentsNullableString struct {
	Present bool
	Nulled  bool
	Value   string
}

func (value documentsNullableString) MarshalJSON() ([]byte, error) {
	if value.Nulled {
		return []byte("null"), nil
	}
	return json.Marshal(value.Value)
}

func (value *documentsNullableString) UnmarshalJSON(data []byte) error {
	trimmed := bytes.TrimSpace(data)
	value.Present = true
	if bytes.Equal(trimmed, []byte("null")) {
		value.Nulled = true
		value.Value = ""
		return nil
	}
	var decoded string
	if err := json.Unmarshal(trimmed, &decoded); err != nil {
		return err
	}
	value.Nulled = false
	value.Value = decoded
	return nil
}

// DocumentsPageSettings mirrors the authored-document page settings object.
type DocumentsPageSettings struct {
	Size        string `json:"size"`
	Orientation string `json:"orientation"`
	Margin      string `json:"margin"`
}

func defaultDocumentsPageSettings() DocumentsPageSettings {
	return DocumentsPageSettings{Size: "A4", Orientation: "portrait", Margin: "normal"}
}

// DocumentsCodingLine is one ingested bill line offered for account coding.
type DocumentsCodingLine struct {
	Description         string `json:"description"`
	QuantityThousandths int64  `json:"quantityThousandths"`
	UnitPriceMinor      int64  `json:"unitPriceMinor"`
}

// DocumentsInput is the single parsed input shape for the module. Zod objects
// strip unknown keys, so only declared keys survive parsing and re-marshal to
// the same canonical payload the TypeScript runtime validated.
type DocumentsInput struct {
	// addVersion, deleteDoc, deleteDocument, listVersions, restoreDocVersion,
	// saveDocVersion, suggestCoding, updateDocMetadata
	DocumentID *string `json:"documentId,omitempty"`
	// addVersion
	ContentBase64 *string `json:"contentBase64,omitempty"`
	RawText       *string `json:"rawText,omitempty"`
	Note          *string `json:"note,omitempty"`
	// createDoc, createDocument, saveDocVersion, updateDocMetadata
	Title *string `json:"title,omitempty"`
	// createTemplate
	Name        *string `json:"name,omitempty"`
	Description *string `json:"description,omitempty"`
	// createDoc, createTemplate, saveDocVersion
	Content json.RawMessage `json:"content,omitempty"`
	// createDoc, saveDocVersion
	HTML *string `json:"html,omitempty"`
	// createDoc, deleteTemplate, getTemplate
	TemplateID   *string                  `json:"templateId,omitempty"`
	DocumentType *string                  `json:"documentType,omitempty"`
	PageSettings *DocumentsPageSettings   `json:"pageSettings,omitempty"`
	IntentID     *string                  `json:"intentId,omitempty"`
	Folder       *documentsNullableString `json:"folder,omitempty"`
	// updateDocMetadata only (the nullable-optional link fields)
	LinkedRecordType  *documentsNullableString `json:"linkedRecordType,omitempty"`
	LinkedRecordID    *documentsNullableString `json:"linkedRecordId,omitempty"`
	LinkedRecordLabel *documentsNullableString `json:"linkedRecordLabel,omitempty"`
	// createDocument
	RefType    *string `json:"refType,omitempty"`
	RefID      *string `json:"refId,omitempty"`
	ExpiresAt  *string `json:"expiresAt,omitempty"`
	Text       *string `json:"text,omitempty"`
	FileBase64 *string `json:"fileBase64,omitempty"`
	MIMEType   *string `json:"mimeType,omitempty"`
	// createFolder, deleteFolder, renameFolder
	Path    *string `json:"path,omitempty"`
	NewPath *string `json:"newPath,omitempty"`
	// restoreDocVersion
	SourceVersion *int64 `json:"sourceVersion,omitempty"`
	// deleteOrgMemory
	MemoryID *string `json:"memoryId,omitempty"`
	// searchMemory
	Query *string `json:"query,omitempty"`
	Limit *int64  `json:"limit,omitempty"`
	// searchRecords
	Type *string `json:"type,omitempty"`
	ID   *string `json:"id,omitempty"`
	// suggestCoding
	Lines []DocumentsCodingLine `json:"lines,omitempty"`
}

// ParseDocumentsInput validates raw JSON for one documents capability and
// returns the module's canonical input shape.
func ParseDocumentsInput(capabilityID string, raw json.RawMessage) (DocumentsInput, error) {
	switch capabilityID {
	case documentsAddVersionCapabilityID:
		return parseAddDocumentVersionInput(raw)
	case documentsCreateDocCapabilityID:
		return parseCreateAuthoredDocumentInput(raw)
	case documentsCreateDocumentCapabilityID:
		return parseIngestDocumentInput(raw)
	case documentsCreateFolderCapabilityID:
		return parseFolderPathInput(raw)
	case documentsCreateTemplateCapabilityID:
		return parseCreateDocumentTemplateInput(raw)
	case documentsDeleteDocCapabilityID:
		return parseAuthoredDocumentIDInput(raw)
	case documentsDeleteDocumentCapabilityID:
		return parseIngestedDocumentIDInput(raw)
	case documentsDeleteFolderCapabilityID:
		return parseFolderPathInput(raw)
	case documentsDeleteOrgMemoryCapabilityID:
		return parseDeleteOrgMemoryInput(raw)
	case documentsDeleteTemplateCapabilityID:
		return parseDocumentTemplateIDInput(raw)
	case documentsGetDocCapabilityID:
		return parseGetAuthoredDocumentInput(raw)
	case documentsGetTemplateCapabilityID:
		return parseDocumentTemplateIDInput(raw)
	case documentsParseDocumentCapabilityID:
		return parseDocumentInput(raw)
	case documentsListDocumentsCapabilityID:
		return parseEmptyDocumentsInput(raw)
	case documentsListFoldersCapabilityID:
		return parseEmptyDocumentsInput(raw)
	case documentsListTemplatesCapabilityID:
		return parseEmptyDocumentsInput(raw)
	case documentsListVersionsCapabilityID:
		return parseIngestedVersionsDocumentIDInput(raw)
	case documentsRenameFolderCapabilityID:
		return parseRenameFolderInput(raw)
	case documentsRestoreDocVersionCapabilityID:
		return parseRestoreDocVersionInput(raw)
	case documentsSaveDocVersionCapabilityID:
		return parseSaveDocVersionInput(raw)
	case documentsSearchMemoryCapabilityID:
		return parseSearchMemoryInput(raw)
	case documentsSearchRecordsCapabilityID:
		return parseSearchRecordsInput(raw)
	case documentsSuggestCodingCapabilityID:
		return parseSuggestCodingInput(raw)
	case documentsUpdateDocMetadataCapabilityID:
		return parseUpdateDocMetadataInput(raw)
	default:
		return DocumentsInput{}, errors.New("unsupported documents capability")
	}
}

func parseEmptyDocumentsInput(raw json.RawMessage) (DocumentsInput, error) {
	if _, err := decodeJSONObject(raw); err != nil {
		return DocumentsInput{}, err
	}
	return DocumentsInput{}, nil
}

// executeDocumentsCapability runs one documents capability inside the
// executor's org transaction and returns the marshalled output. Business-rule
// refusals come back as documentsRejection so the caller can answer 422.
func executeDocumentsCapability(
	ctx context.Context,
	tx pgx.Tx,
	claims authbridge.CapabilityClaims,
	capabilityID string,
	input DocumentsInput,
	now time.Time,
) (json.RawMessage, error) {
	var (
		output any
		err    error
	)
	switch capabilityID {
	case documentsAddVersionCapabilityID:
		output, err = addDocumentVersion(ctx, tx, claims, input, now)
	case documentsCreateDocCapabilityID:
		output, err = createAuthoredDocument(ctx, tx, claims, input)
	case documentsCreateDocumentCapabilityID:
		output, err = ingestDocument(ctx, tx, claims, input)
	case documentsCreateFolderCapabilityID:
		output, err = createDocumentFolder(ctx, tx, claims, input)
	case documentsCreateTemplateCapabilityID:
		output, err = createDocumentTemplate(ctx, tx, claims, input)
	case documentsDeleteDocCapabilityID:
		output, err = deleteAuthoredDocument(ctx, tx, claims, input)
	case documentsDeleteDocumentCapabilityID:
		output, err = deleteIngestedDocument(ctx, tx, claims, input)
	case documentsDeleteFolderCapabilityID:
		output, err = deleteDocumentFolder(ctx, tx, claims, input)
	case documentsDeleteOrgMemoryCapabilityID:
		output, err = deleteOrgMemory(ctx, tx, claims, input)
	case documentsDeleteTemplateCapabilityID:
		output, err = deleteDocumentTemplate(ctx, tx, claims, input)
	case documentsGetDocCapabilityID:
		output, err = getAuthoredDocument(ctx, tx, claims, input)
	case documentsGetTemplateCapabilityID:
		output, err = getDocumentTemplate(ctx, tx, claims, input)
	case documentsParseDocumentCapabilityID:
		output, err = parseIngestedDocument(ctx, tx, claims, input)
	case documentsListDocumentsCapabilityID:
		output, err = listIngestedDocuments(ctx, tx, claims.OrganizationID)
	case documentsListFoldersCapabilityID:
		output, err = listDocumentFolders(ctx, tx, claims.OrganizationID)
	case documentsListTemplatesCapabilityID:
		output, err = listDocumentTemplates(ctx, tx, claims.OrganizationID)
	case documentsListVersionsCapabilityID:
		output, err = listIngestedDocumentVersions(ctx, tx, claims, input)
	case documentsRenameFolderCapabilityID:
		output, err = renameDocumentFolder(ctx, tx, claims, input, now)
	case documentsRestoreDocVersionCapabilityID:
		output, err = restoreAuthoredDocumentVersion(ctx, tx, claims, input, now)
	case documentsSaveDocVersionCapabilityID:
		output, err = saveAuthoredDocumentVersion(ctx, tx, claims, input, now)
	case documentsSearchMemoryCapabilityID:
		output, err = searchOrgMemory(ctx, tx, claims.OrganizationID, input)
	case documentsSearchRecordsCapabilityID:
		output, err = searchRecordsForDocument(ctx, tx, claims, input, now)
	case documentsSuggestCodingCapabilityID:
		output, err = suggestDocumentCoding(ctx, tx, claims, input)
	case documentsUpdateDocMetadataCapabilityID:
		output, err = updateAuthoredDocumentMetadata(ctx, tx, claims, input, now)
	default:
		return nil, errors.New("unsupported documents capability")
	}
	if err != nil {
		return nil, err
	}
	return marshalJS(output)
}
