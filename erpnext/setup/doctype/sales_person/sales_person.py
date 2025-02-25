# Copyright (c) 2015, Frappe Technologies Pvt. Ltd. and Contributors
# License: GNU General Public License v3. See license.txt

from __future__ import unicode_literals
import frappe
from frappe import _
from frappe.utils import flt
from frappe.utils.nestedset import NestedSet, get_root_of
from erpnext import get_default_currency
from erpnext.selling.doctype.sales_commission_category.sales_commission_category import get_commission_rate


class SalesPerson(NestedSet):
	nsm_parent_field = 'parent_sales_person'

	def validate(self):
		if not self.parent_sales_person:
			self.parent_sales_person = get_root_of("Sales Person")

		for d in self.get('targets') or []:
			if not flt(d.target_qty) and not flt(d.target_alt_uom_qty) and not flt(d.target_amount):
				frappe.throw(_("Row {0}: Either Target Stock Qty or Target Contents Qty or Target Amount is mandatory.")
					.format(d.idx))
		self.validate_employee_id()

	def onload(self):
		self.load_dashboard_info()

	def load_dashboard_info(self):
		company_default_currency = get_default_currency()

		allocated_amount = frappe.db.sql("""
			select sum(allocated_amount)
			from `tabSales Team`
			where sales_person = %s and docstatus=1 and parenttype = 'Sales Invoice'
		""",(self.sales_person_name))

		allocated_qty = frappe.db.sql("""
			select
				sum(inv.total_qty * steam.allocated_percentage / 100),
				sum(inv.total_alt_uom_qty * steam.allocated_percentage / 100)
			from `tabSales Team` steam
			inner join `tabSales Invoice` inv on steam.parent = inv.name
			where steam.sales_person = %s and inv.docstatus=1 and steam.parenttype = 'Sales Invoice'
		""",(self.sales_person_name))

		info = {}
		info["allocated_amount"] = flt(allocated_amount[0][0]) if allocated_amount else 0
		info["allocated_stock_qty"] = flt(allocated_qty[0][0]) if allocated_qty else 0
		info["allocated_alt_uom_qty"] = flt(allocated_qty[0][1]) if allocated_qty else 0
		info["currency"] = company_default_currency

		self.set_onload('dashboard_info', info)

	def on_update(self):
		super(SalesPerson, self).on_update()
		self.validate_one_root()

	def get_email_id(self):
		if self.employee:
			user = frappe.db.get_value("Employee", self.employee, "user_id")
			if not user:
				frappe.throw(_("User ID not set for Employee {0}").format(self.employee))
			else:
				return frappe.db.get_value("User", user, "email") or user

	def validate_employee_id(self):
		if self.employee:
			sales_person = frappe.db.get_value("Sales Person", {"employee": self.employee})

			if sales_person and sales_person != self.name:
				frappe.throw(_("Another Sales Person {0} exists with the same Employee id").format(sales_person))

def on_doctype_update():
	frappe.db.add_index("Sales Person", ["lft", "rgt"])

def get_timeline_data(doctype, name):

	out = {}

	out.update(dict(frappe.db.sql('''select
			unix_timestamp(dt.transaction_date), count(st.parenttype)
		from
			`tabSales Order` dt, `tabSales Team` st
		where
			st.sales_person = %s and st.parent = dt.name and dt.transaction_date > date_sub(curdate(), interval 1 year)
			group by dt.transaction_date ''', name)))

	sales_invoice = dict(frappe.db.sql('''select
			unix_timestamp(dt.posting_date), count(st.parenttype)
		from
			`tabSales Invoice` dt, `tabSales Team` st
		where
			st.sales_person = %s and st.parent = dt.name and dt.posting_date > date_sub(curdate(), interval 1 year)
			group by dt.posting_date ''', name))

	for key in sales_invoice:
		if out.get(key):
			out[key] += sales_invoice[key]
		else:
			out[key] = sales_invoice[key]

	delivery_note = dict(frappe.db.sql('''select
			unix_timestamp(dt.posting_date), count(st.parenttype)
		from
			`tabDelivery Note` dt, `tabSales Team` st
		where
			st.sales_person = %s and st.parent = dt.name and dt.posting_date > date_sub(curdate(), interval 1 year)
			group by dt.posting_date ''', name))

	for key in delivery_note:
		if out.get(key):
			out[key] += delivery_note[key]
		else:
			out[key] = delivery_note[key]

	return out


@frappe.whitelist()
def get_sales_person_from_user():
	sales_person = frappe.db.sql("""
		select sp.name
		from `tabSales Person` sp
		inner join `tabEmployee` emp on emp.name = sp.employee
		where sp.enabled = 1 and emp.user_id = %s
		limit 1
	""", frappe.session.user)

	return sales_person[0][0] if sales_person else None


@frappe.whitelist()
def get_sales_person_commission_details(sales_person):
	out = frappe._dict()

	if sales_person:
		out.sales_commission_category = frappe.get_cached_value("Sales Person", sales_person, 'sales_commission_category')
	else:
		out.sales_commission_category = None

	out.commission_rate = get_commission_rate(out.sales_commission_category)

	return out
