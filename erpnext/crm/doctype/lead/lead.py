# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import (cstr, validate_email_address, cint, comma_and, has_gravatar, now, getdate, nowdate)
from frappe.model.mapper import get_mapped_doc

from erpnext.controllers.selling_controller import SellingController
from frappe.contacts.address_and_contact import load_address_and_contact
from erpnext.accounts.party import set_taxes
from frappe.email.inbox import link_communication_to_document

sender_field = "email_id"


class Lead(SellingController):
	def __init__(self, *args, **kwargs):
		super(Lead, self).__init__(*args, **kwargs)
		self.status_map = [
			["Lost Quotation", "has_lost_quotation"],
			["Opportunity", "has_opportunity"],
			["Quotation", "has_quotation"],
			["Converted", "has_customer"],
		]

	def get_feed(self):
		return '{0}: {1}'.format(_(self.status), self.lead_name)

	def onload(self):
		customer = get_customer_from_lead(self.name)
		self.get("__onload").is_customer = customer
		load_address_and_contact(self)

	def validate(self):
		self.set_lead_name()
		self._prev = frappe._dict({
			"contact_date": frappe.db.get_value("Lead", self.name, "contact_date") if \
				(not cint(self.get("__islocal"))) else None,
			"ends_on": frappe.db.get_value("Lead", self.name, "ends_on") if \
				(not cint(self.get("__islocal"))) else None,
			"contact_by": frappe.db.get_value("Lead", self.name, "contact_by") if \
				(not cint(self.get("__islocal"))) else None,
		})

		self.validate_organization_lead()
		self.validate_tax_id()
		self.validate_mobile_no()

		self.set_status()
		self.check_email_id_is_unique()

		if self.email_id:
			if not self.flags.ignore_email_validation:
				validate_email_address(self.email_id, True)

			if self.email_id == self.lead_owner:
				frappe.throw(_("Lead Owner cannot be same as the Lead"))

			if self.email_id == self.contact_by:
				frappe.throw(_("Next Contact By cannot be same as the Lead Email Address"))

			if self.is_new() or not self.image:
				self.image = has_gravatar(self.email_id)

		if self.contact_date and getdate(self.contact_date) < getdate(nowdate()):
			frappe.throw(_("Next Contact Date cannot be in the past"))

		if (self.ends_on and self.contact_date and
			(getdate(self.ends_on) < getdate(self.contact_date))):
			frappe.throw(_("Ends On date cannot be before Next Contact Date."))

	def on_update(self):
		self.add_calendar_event()

	def add_calendar_event(self, opts=None, force=False):
		super(Lead, self).add_calendar_event({
			"owner": self.lead_owner,
			"starts_on": self.contact_date,
			"ends_on": self.ends_on or "",
			"subject": ('Contact ' + cstr(self.lead_name)),
			"description": ('Contact ' + cstr(self.lead_name)) + \
				(self.contact_by and ('. By : ' + cstr(self.contact_by)) or '')
		}, force)

	def check_email_id_is_unique(self):
		if self.email_id:
			# validate email is unique
			duplicate_leads = frappe.db.sql_list("""select name from tabLead
				where email_id=%s and name!=%s""", (self.email_id, self.name))

			if duplicate_leads:
				frappe.throw(_("Email Address must be unique, already exists for {0}")
					.format(comma_and(duplicate_leads)), frappe.DuplicateEntryError)

	def on_trash(self):
		frappe.db.sql("""update `tabIssue` set lead='' where lead=%s""",
			self.name)

		self.delete_events()

	def validate_tax_id(self):
		from erpnext.accounts.party import validate_ntn_cnic_strn
		validate_ntn_cnic_strn(self.get('tax_id'), self.get('tax_cnic'), self.get('tax_strn'))

	def validate_mobile_no(self):
		from erpnext.accounts.party import validate_mobile_pakistan

		if self.get('mobile_no_2') and not self.get('mobile_no'):
			self.mobile_no = self.mobile_no_2
			self.mobile_no_2 = ""

		validate_mobile_pakistan(self.get('mobile_no'))
		validate_mobile_pakistan(self.get('mobile_no_2'))

	def validate_organization_lead(self):
		if cint(self.organization_lead):
			self.lead_name = self.company_name
			self.gender = None
			self.salutation = None

	def has_customer(self):
		return frappe.db.get_value("Customer", {"lead_name": self.name})

	def has_opportunity(self):
		return frappe.db.get_value("Opportunity", {"party_name": self.name, "status": ["!=", "Lost"]})

	def has_quotation(self):
		quotation = frappe.db.get_value("Quotation", {
			"quotation_to": "Lead",
			"party_name": self.name,
			"docstatus": 1,
			"status": ["!=", "Lost"]
		})

		vehicle_quotation = frappe.db.get_value("Vehicle Quotation", {
			"quotation_to": "Lead",
			"party_name": self.name,
			"docstatus": 1,
			"status": ["!=", "Lost"]
		})

		return quotation or vehicle_quotation

	def has_lost_quotation(self):
		quotation = frappe.db.get_value("Quotation", {
			"quotation_to": "Lead",
			"party_name": self.name,
			"docstatus": 1,
			"status": "Lost"
		})

		vehicle_quotation = frappe.db.get_value("Vehicle Quotation", {
			"quotation_to": "Lead",
			"party_name": self.name,
			"docstatus": 1,
			"status": "Lost"
		})

		return quotation or vehicle_quotation

	def set_lead_name(self):
		if not self.lead_name:
			# Check for leads being created through data import
			if not self.company_name and not self.flags.ignore_mandatory:
				frappe.throw(_("A Lead requires either a person's name or an organization's name"))

			self.lead_name = self.company_name


@frappe.whitelist()
def make_customer(source_name, target_doc=None):
	return _make_customer(source_name, target_doc)


def _make_customer(source_name, target_doc=None, ignore_permissions=False):
	def set_missing_values(source, target):
		if source.company_name:
			target.customer_type = "Company"
			target.customer_name = source.company_name
		else:
			target.customer_type = "Individual"
			target.customer_name = source.lead_name

		target.customer_group = frappe.db.get_default("Customer Group")

	doclist = get_mapped_doc("Lead", source_name, {
		"Lead": {
			"doctype": "Customer",
			"field_map": {
				"name": "lead_name",
				"company_name": "customer_name",
				"lead_name": "contact_first_name",
			}
		}
	}, target_doc, set_missing_values, ignore_permissions=ignore_permissions)

	return doclist


def get_customer_from_lead(lead, throw=False):
	if not lead:
		return None

	customer = frappe.db.get_value("Customer", {"lead_name": lead})
	if not customer and throw:
		frappe.throw(_("Please convert Lead to Customer first"))

	return customer


@frappe.whitelist()
def set_lead_for_customer(lead, customer):
	doc = frappe.get_doc("Customer", customer)

	# check if customer linked to another lead
	if doc.lead_name and doc.lead_name != lead:
		frappe.throw(_("{0} is already linked to another {1}")
			.format(frappe.get_desk_link("Customer", customer), frappe.get_desk_link("Lead", lead)))

	doc.lead_name = lead
	doc.save()

	frappe.msgprint(_("{0} converted to {1}")
		.format(frappe.get_desk_link("Lead", lead), frappe.get_desk_link("Customer", customer)),
		indicator="green")


@frappe.whitelist()
def make_opportunity(source_name, target_doc=None):
	def set_missing_values(source, target):
		_set_missing_values(source, target)

	target_doc = get_mapped_doc("Lead", source_name,
		{"Lead": {
			"doctype": "Opportunity",
			"field_map": {
				"campaign_name": "campaign",
				"doctype": "opportunity_from",
				"name": "party_name",
				"lead_name": "contact_display",
				"company_name": "customer_name",
				"email_id": "contact_email",
				"mobile_no": "contact_mobile"
			}
		}}, target_doc, set_missing_values)

	return target_doc


@frappe.whitelist()
def make_quotation(source_name, target_doc=None):
	def set_missing_values(source, target):
		_set_missing_values(source, target)

	target_doc = get_mapped_doc("Lead", source_name,
		{"Lead": {
			"doctype": "Quotation",
			"field_map": {
				"name": "party_name"
			}
		}}, target_doc, set_missing_values)

	target_doc.quotation_to = "Lead"
	target_doc.run_method("set_missing_values")
	target_doc.run_method("set_other_charges")
	target_doc.run_method("calculate_taxes_and_totals")


@frappe.whitelist()
def make_vehicle_quotation(source_name, target_doc=None):
	def set_missing_values(source, target):
		_set_missing_values(source, target)

	target_doc = get_mapped_doc("Lead", source_name,
		{"Lead": {
			"doctype": "Vehicle Quotation",
			"field_map": {
				"name": "party_name"
			}
		}}, target_doc, set_missing_values)

	target_doc.quotation_to = "Lead"
	target_doc.run_method("set_missing_values")
	target_doc.run_method("calculate_taxes_and_totals")

	return target_doc


def _set_missing_values(source, target):
	address = frappe.get_all('Dynamic Link', {
			'link_doctype': source.doctype,
			'link_name': source.name,
			'parenttype': 'Address',
		}, ['parent'], limit=1)

	contact = frappe.get_all('Dynamic Link', {
			'link_doctype': source.doctype,
			'link_name': source.name,
			'parenttype': 'Contact',
		}, ['parent'], limit=1)

	if address:
		target.customer_address = address[0].parent

	if contact:
		target.contact_person = contact[0].parent


@frappe.whitelist()
def get_lead_details(lead, posting_date=None, company=None):
	if not lead: return frappe._dict()

	from erpnext.accounts.party import set_address_details
	out = frappe._dict()

	lead_doc = frappe.get_doc("Lead", lead)
	lead = lead_doc

	out["customer_name"] = lead.company_name or lead.lead_name
	out["territory"] = lead.territory

	out.update(_get_lead_contact_details(lead))

	set_address_details(out, lead, "Lead")

	taxes_and_charges = set_taxes(None, 'Lead', posting_date, company,
		billing_address=out.get('customer_address'), shipping_address=out.get('shipping_address_name'))
	if taxes_and_charges:
		out['taxes_and_charges'] = taxes_and_charges

	return out


@frappe.whitelist()
def get_lead_contact_details(lead):
	if not lead:
		return frappe._dict()

	lead_doc = frappe.get_doc("Lead", lead)
	return _get_lead_contact_details(lead_doc)


def _get_lead_contact_details(lead):
	out = frappe._dict({
		"contact_email": lead.get('email_id'),
		"contact_mobile": lead.get('mobile_no'),
		"contact_mobile_2": lead.get('mobile_no_2'),
		"contact_phone": lead.get('phone'),
	})

	if cint(lead.organization_lead):
		out["contact_display"] = ""
		out["contact_designation"] = ""
	else:
		out["contact_display"] = " ".join(filter(None, [lead.salutation, lead.lead_name]))
		out["contact_designation"] = lead.get('designation')

	return out


@frappe.whitelist()
def make_lead_from_communication(communication, ignore_communication_links=False):
	""" raise a issue from email """

	doc = frappe.get_doc("Communication", communication)
	lead_name = None
	if doc.sender:
		lead_name = frappe.db.get_value("Lead", {"email_id": doc.sender})
	if not lead_name and doc.phone_no:
		lead_name = frappe.db.get_value("Lead", {"mobile_no": doc.phone_no})
	if not lead_name:
		lead = frappe.get_doc({
			"doctype": "Lead",
			"lead_name": doc.sender_full_name,
			"email_id": doc.sender,
			"mobile_no": doc.phone_no
		})
		lead.flags.ignore_mandatory = True
		lead.flags.ignore_permissions = True
		lead.insert()

		lead_name = lead.name

	link_communication_to_document(doc, "Lead", lead_name, ignore_communication_links)
	return lead_name


def get_lead_with_phone_number(number):
	if not number: return

	leads = frappe.get_all('Lead', or_filters={
		'phone': ['like', '%{}'.format(number)],
		'mobile_no': ['like', '%{}'.format(number)]
	}, limit=1)

	lead = leads[0].name if leads else None

	return lead
