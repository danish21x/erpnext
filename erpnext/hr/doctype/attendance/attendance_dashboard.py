from __future__ import unicode_literals
from frappe import _

def get_data():
	return {
		'fieldname': 'attendance',
		'transactions': [
			{
				'label': _('Checkins'),
				'items': ['Employee Checkin']
			}
		]
	}
