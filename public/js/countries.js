// public/js/countries.js
// A practical country list plus states/provinces for countries where a
// dropdown is genuinely useful. Countries without a predefined list fall
// back to a free-text "State / Region" input in the booking form.
window.COUNTRIES = [
  'Nigeria','Ghana','Kenya','South Africa','Egypt','Morocco','Ethiopia','Tanzania','Uganda','Rwanda','Senegal','Ivory Coast','Cameroon','Zambia','Zimbabwe','Botswana','Namibia',
  'United States','Canada','United Kingdom','Ireland','France','Germany','Spain','Portugal','Italy','Netherlands','Belgium','Switzerland','Austria','Sweden','Norway','Denmark','Finland','Poland','Greece','Turkey','Russia','Ukraine',
  'India','China','Japan','South Korea','Indonesia','Malaysia','Singapore','Philippines','Thailand','Vietnam','Pakistan','Bangladesh','Sri Lanka','Nepal',
  'United Arab Emirates','Saudi Arabia','Qatar','Kuwait','Israel','Jordan','Lebanon',
  'Australia','New Zealand',
  'Brazil','Mexico','Argentina','Chile','Colombia','Peru','Venezuela',
  'Other',
];

window.STATES_BY_COUNTRY = {
  'Nigeria': ['Abia','Adamawa','Akwa Ibom','Anambra','Bauchi','Bayelsa','Benue','Borno','Cross River','Delta','Ebonyi','Edo','Ekiti','Enugu','FCT (Abuja)','Gombe','Imo','Jigawa','Kaduna','Kano','Katsina','Kebbi','Kogi','Kwara','Lagos','Nasarawa','Niger','Ogun','Ondo','Osun','Oyo','Plateau','Rivers','Sokoto','Taraba','Yobe','Zamfara'],
  'Ghana': ['Ahafo','Ashanti','Bono','Bono East','Central','Eastern','Greater Accra','North East','Northern','Oti','Savannah','Upper East','Upper West','Volta','Western','Western North'],
  'Kenya': ['Nairobi','Mombasa','Kisumu','Nakuru','Uasin Gishu','Kiambu','Machakos','Kajiado','Kilifi','Nyeri'],
  'South Africa': ['Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','North West','Northern Cape','Western Cape'],
  'United States': ['Alabama','Alaska','Arizona','Arkansas','California','Colorado','Connecticut','Delaware','Florida','Georgia','Hawaii','Idaho','Illinois','Indiana','Iowa','Kansas','Kentucky','Louisiana','Maine','Maryland','Massachusetts','Michigan','Minnesota','Mississippi','Missouri','Montana','Nebraska','Nevada','New Hampshire','New Jersey','New Mexico','New York','North Carolina','North Dakota','Ohio','Oklahoma','Oregon','Pennsylvania','Rhode Island','South Carolina','South Dakota','Tennessee','Texas','Utah','Vermont','Virginia','Washington','West Virginia','Wisconsin','Wyoming'],
  'Canada': ['Alberta','British Columbia','Manitoba','New Brunswick','Newfoundland and Labrador','Nova Scotia','Ontario','Prince Edward Island','Quebec','Saskatchewan'],
  'United Kingdom': ['England','Scotland','Wales','Northern Ireland'],
  'India': ['Andhra Pradesh','Bihar','Delhi','Gujarat','Karnataka','Kerala','Madhya Pradesh','Maharashtra','Punjab','Rajasthan','Tamil Nadu','Telangana','Uttar Pradesh','West Bengal'],
  'Australia': ['New South Wales','Queensland','South Australia','Tasmania','Victoria','Western Australia','Northern Territory','Australian Capital Territory'],
  'United Arab Emirates': ['Abu Dhabi','Dubai','Sharjah','Ajman','Fujairah','Ras Al Khaimah','Umm Al Quwain'],
};

// A handful of common government-issued ID types for the reservation form.
window.ID_TYPES = ["National ID Card","International Passport","Driver's License","Voter's Card","Company ID","Other"];
